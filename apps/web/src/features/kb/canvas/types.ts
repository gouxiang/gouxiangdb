// apps/web/src/features/kb/canvas/types.ts
// 画布增强层的数据约定（#116-#121）：
//  - 样式类需求（线宽/文字样式/连线颜色虚实箭头/呈现方式）全部走 @plait 原生元素字段与
//    PropertyTransforms / DrawTransforms / TextTransforms，天然进入 plait 撤销栈、随画布 JSON 持久化。
//  - 注释、关联文档两类扩展数据挂在节点自定义字段上（PlaitElement 允许任意键，库的
//    normalize/move/resize 只改已知字段，不会剥离未知键），保存即随 onValueChange 上云。
//
// 自定义字段：
//   gxNote?: string                                  节点注释正文
//   gxDocRef?: { docId: string; kind: "doc"|"canvas"; title: string }  节点关联的文档/画布

import type { PlaitElement, Point } from "@plait/core";
import { PlaitDrawElement } from "@plait/draw";

export interface GxDocRef {
  docId: string;
  kind: "doc" | "canvas";
  /** 插入时快照标题；实时标题由预览组件拉取，此处仅用于离线/无权限时兜底展示 */
  title: string;
  /** 本地重命名（覆盖源标题，画布块标题旁的 edit 图标写入） */
  displayTitle?: string;
  /** 预览类型：full=完整预览（带摘要/图片）；minimal=极简（仅标题+跳转） */
  previewType?: "full" | "minimal";
  /** 顺序（多预览时排序，插入时按现有块数自动写入） */
  order?: number;
}

export type GxShapeElement = PlaitElement & {
  type: "geometry";
  points: Point[];
  shape: string;
  gxNote?: string;
  gxDocRef?: GxDocRef;
};

export type GxLineElement = PlaitElement & {
  type: "arrow-line" | "vector-line";
  gxNote?: string;
};

/** F4: 直接插入式关联块
 * 用 plait 原生 geometry rectangle 作为承载（自带渲染/选中/拖拽/缩放手柄），仅在 gxLinkRef 字段上有值时识别为关联块。
 * 视觉由外层 GxLinkBlockView 覆盖渲染；plait 的矩形作为不可见锚点 + 选中框。
 */
export type GxLinkBlock = PlaitElement & {
  type: "geometry";
  shape: "rectangle";
  points: Point[];
  /** 关联目标文档/画布 */
  gxLinkRef: GxDocRef;
  /** 最近一次更新时间（便于审计） */
  updatedAt?: string;
  /** 自定义画笔样式：fill 透明避免显示默认底色，避免与 NodeStyleBar 重叠高亮 */
  fill?: string;
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
};

export function isLinkBlock(el: PlaitElement | undefined | null): el is GxLinkBlock {
  if (!el) return false;
  return el.type === "geometry" && (el as { shape?: string }).shape === "rectangle" && !!(el as { gxLinkRef?: unknown }).gxLinkRef;
}

export function isShapeLike(el: PlaitElement | undefined | null): el is GxShapeElement {
  if (!el) return false;
  // 几何图形（BasicShapes/Flowchart/UML）。图片/纯文本/泳道/表格不算可承载注释关联的"框体"。
  try {
    if (PlaitDrawElement.isGeometry(el)) return true;
  } catch {
    /* 类型判断异常按 false 处理 */
  }
  return false;
}

export function isLineLike(el: PlaitElement | undefined | null): el is GxLineElement {
  if (!el) return false;
  return el.type === "arrow-line" || el.type === "vector-line";
}

/** 图片元素（drawnix 原生 image 节点） */
export function isImageEl(el: PlaitElement | undefined | null): boolean {
  if (!el) return false;
  try {
    return PlaitDrawElement.isImage(el);
  } catch {
    return false;
  }
}

/** 纯文本元素（drawnix 原生 text 节点） */
export function isTextEl(el: PlaitElement | undefined | null): boolean {
  if (!el) return false;
  try {
    return PlaitDrawElement.isText(el);
  } catch {
    return false;
  }
}

/**
 * 选中后可弹出 NodeStyleBar 的对象（至少支持"图层"管理；具体样式按钮按元素类型条件渲染）：
 * 基础几何、箭头/线条、思维导图节点、图片、文字（关联块是 geometry 矩形，已含于 isShapeLike）。
 */
export function isStyleBarEligible(el: PlaitElement | undefined | null): boolean {
  return isShapeLike(el) || isLineLike(el) || isMindMapNode(el) || isImageEl(el) || isTextEl(el);
}

/** 可挂注释/关联的元素：几何图形 + 连线 + 思维导图节点 */
export function isAnnotatable(el: PlaitElement | undefined | null): boolean {
  return isShapeLike(el) || isLineLike(el) || isMindMapNode(el);
}

/** F3: 流程图分支线（flowchart 节点之间的连接线）—— 同样走 GxLineElement，但有专门的 stroke/fill 字段 */
export function isBranchLine(el: PlaitElement | undefined | null): el is GxLineElement {
  if (!el) return false;
  // Drawnix 流程图分支线 type 通常是 'flowchart-branch' 或带 source.kind === 'flowchart'
  return (
    el.type === "flowchart-branch" ||
    (isLineLike(el) && (el as unknown as { source?: { kind?: string } }).source?.kind === "flowchart")
  );
}

/** F5: 思维导图节点 —— @plait/mind 0.89.2 真实类型串（element.d.ts）。
 * 真实取值："mind"（根）/"mind_child"（子节点）/"mindmap"（历史遗留）。
 * 注意：mindmap 没有独立的"线"元素，分支样式挂在节点自身的 branchColor/branchWidth/branchShape 字段。
 */
export function isMindMapNode(el: PlaitElement | undefined | null): boolean {
  if (!el) return false;
  const t = (el as { type?: string }).type;
  return t === "mind" || t === "mind_child" || t === "mindmap";
}

/** F5: 思维导图分支线 —— @plait/mind 0.89.2 不存在独立线元素，分支样式挂在节点自身字段上。
 * 保留函数签名以兼容旧调用点（返回 false 即可）。
 */
export function isMindMapLine(_el: PlaitElement | undefined | null): boolean {
  return false;
}

// apps/web/src/features/kb/canvas/GxCanvas.tsx
// 统一画布装配入口（所有"完整能力"画布实例的唯一推荐入口）。
//
// 解决的问题（本轮问题 3）：历史上各调用点各自拼 <DrawnixCanvas> 的 props，
//   主画布传了 enhance（关联块/注释角标/样式条/插入入口等全套增强），
//   而"弹窗内编辑嵌套画布"(CanvasEditModal) 漏传 enhance，导致嵌套画布只有 Drawnix
//   最初始功能、后续为画布新增的优化全部不生效。
//
// 统一约定：
//   - DrawnixCanvas 负责"一块画布如何初始化/渲染/只读手势"；
//   - CanvasEnhanceOverlay（由 enhance 开启）是"我方画布能力"的唯一来源；
//   - 本组件把"画布身份上下文(kbId/publicToken/currentDocId) + 交互模式(canEdit)"
//     到 readonly / allowViewInteraction / enhance 的拼装收敛到一处。
//
// 因此：未来新增任何画布能力，只需加进 CanvasEnhanceOverlay / canvas-ops，
//   所有走 GxCanvas 的实例（主画布、公开分享画布、弹窗内编辑的嵌套画布）自动获得，
//   不会再出现"某个实例漏传 props 导致能力缺失"。
//
// 两种用途：
//   - 完整能力实例（编辑 / 只读查看都需要节点角标、关联预览等）→ 用本组件。
//   - 纯只读小预览（卡片内嵌 RefEmbedBody、文档内 CanvasEmbed、历史快照）刻意仍用
//     <DrawnixCanvas readonly allowViewInteraction/>（不带 enhance），避免"卡片里再开卡片"
//     的递归浮层；这些场景不需要我方编辑/关联能力。

import { DrawnixCanvas } from "../DrawnixCanvas";

export interface GxCanvasProps {
  /** 画布 JSON（doc.content）；切换文档/整体替换内容时由调用方从外部给 key 重挂载 */
  content: string | undefined;
  /** 当前画布自身文档 id（关联选择器据此排除"关联自己"；也作为内部稳定 key） */
  docId: string;
  /** 是否可编辑（内部权限 + 公开分享角色的合取，由调用方算好传入） */
  canEdit: boolean;
  /** 所属知识库 id（内部页有；公开页可缺省） */
  kbId?: string;
  /** 公开分享 token；存在时数据通道走匿名 PublicApi */
  publicToken?: string;
  /** 编辑回调（每次编辑上抛最新 JSON，防抖/保存由调用方接管） */
  onContentChange?: (json: string) => void;
  /** Cmd/Ctrl+S 保存（可编辑时生效） */
  onSave?: () => void | Promise<void>;
  /** 挂载后自动适配全貌（一般仅只读预览需要） */
  fitOnLoad?: boolean;
}

export function GxCanvas({
  content,
  docId,
  canEdit,
  kbId,
  publicToken,
  onContentChange,
  onSave,
  fitOnLoad,
}: GxCanvasProps) {
  return (
    <DrawnixCanvas
      key={docId}
      content={content}
      onContentChange={onContentChange}
      onSave={onSave}
      // 只读也允许查看交互（滚轮/触控板缩放平移、点击节点关联角标展开），
      // 结构编辑手势由 DrawnixCanvas 内部 capture 拦截 + enhance 内 canEdit 门控双重保证；
      // 不再用全屏 pointer 遮罩（遮罩会连角标点击一起拦死，是公开页关联展不开的旧根因）。
      readonly={!canEdit}
      allowViewInteraction={!canEdit}
      fitOnLoad={fitOnLoad}
      // 增强层无论只读与否都挂：只读成员/公开 viewer 仍能看到注释、节点关联角标与预览；
      // 样式条/插入入口/删除等编辑 UI 在 CanvasEnhanceOverlay 内按 canEdit/publicToken 自门控。
      enhance={{ kbId, publicToken, currentDocId: docId, canEdit }}
    />
  );
}

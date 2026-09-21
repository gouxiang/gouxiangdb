// apps/web/src/features/kb/canvas/link-picker-types.ts
// 关联选择器对外的最小类型契约（CanvasLinkPicker / LinkPickerWrappers / 各调用点共用）。
//
// 单独成文件是为了避免「封装层 import 主组件、主组件又 re-export 封装层」形成循环依赖。

import type { GxRefKind } from "./types";

/** 独立块的预览密度：full=带摘要/内容的完整预览；minimal=仅标题+跳转。 */
export type PreviewType = "full" | "minimal";

/**
 * 选择结果。kind="table" 时 docId 承载 tableId，
 * 并额外带 viewId/viewName（视图快照，供离线/无权限时兜底展示）与 baseId（拼跳转链接用）。
 */
export interface PickResult {
  docId: string;
  kind: GxRefKind;
  title: string;
  viewId?: string | null;
  viewName?: string;
  baseId?: string;
}

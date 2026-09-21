// apps/web/src/features/kb/TableEmbed.tsx
// 文档正文里的【数据表内嵌】宿主（对应 Markdown 的 ```table-embed 围栏）。
//
// 由 enhanceEmbeds 挂到独立 React root 里（不在主应用 Provider 树内），所以：
//   - 能用 Router context（enhanceEmbeds 已套 MemoryRouter）；
//   - 不在这里调用 useNavigate —— 跳转需要 baseId，而文档侧的围栏只带 tableId/viewId，
//     故本宿主不提供「打开数据表」入口（画布侧的关联块才有 baseId 快照）。
//
// 写权限来自宿主：分享态由宿主文档/画布的分享档位决定（MarkdownEditor.embedCanEdit），
// 登录态回落「本文档可编辑」。预览组件自身再与后端响应的 canEdit 取与（fail-closed）。

import { Icon } from "../../components/icons";
import { TableEmbedPreview } from "./canvas/TableEmbedPreview";

export interface TableEmbedProps {
  tableId: string;
  viewId?: string | null;
  /** 内部知识库 id（当前仅用于展示来源，不参与取数） */
  kbId?: string;
  /** 公开分享 token：有值 = 分享态（匿名通道） */
  publicToken?: string;
  /** 宿主档位允许的写权限（见文件头注释） */
  embedCanEdit?: boolean;
}

export function TableEmbed({ tableId, viewId, publicToken, embedCanEdit }: TableEmbedProps) {
  return (
    <div className="my-3 overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface">
      <div className="flex items-center gap-1.5 border-b border-gx-hairline px-2.5 py-1.5 text-gx-11 text-gx-text-hint">
        <Icon name="table" size={12} />
        <span className="min-w-0 flex-1 truncate">内嵌数据表</span>
        {!embedCanEdit && (
          <span className="inline-flex shrink-0 items-center gap-1">
            <Icon name="eye" size={11} />
            只读
          </span>
        )}
      </div>
      <div className="h-80">
        <TableEmbedPreview
          tableId={tableId}
          viewId={viewId ?? null}
          publicToken={publicToken}
          canEdit={!!embedCanEdit}
        />
      </div>
    </div>
  );
}

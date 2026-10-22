// apps/web/src/features/kb/PublicSharedTable.tsx
// 公开分享的数据表只读网格（外部人免登录）。
//
// 两种入口共用本组件：
//   - 直连数据表 token（PublicSharePage 的 table 分支，access.kind="token"）；
//   - 库分享外壳点进的某张表（/s/:baseToken/t/:tableId，access.kind="base"）。
//
// 硬约束：**纯只读**——不渲染新增/删除/单元格编辑/行打开等任何写入口，单元格恒按
// viewer 权限渲染（复用 CellRenderer，不重写一套）。支持分页（limit/offset）。

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { permissionsForRole, type CellValue } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Spinner } from "../../components/ui";
import { CellRenderer } from "../cells/CellRenderer";
import { cellValueOf as cellVal } from "./canvas/table-embed-data";
import { usePublicGridData, type PublicGridAccess } from "./public-grid-data";
import { useProductName } from "../branding/useBranding";

const MAX_COL_PX = 240;

export function PublicSharedTable({
  access,
  titleOverride,
  onBack,
}: {
  access: PublicGridAccess;
  /** 库外壳进入时可用外壳库名/面包屑，缺省用后端返回的表名 */
  titleOverride?: string;
  /** 库作用域进入时提供「返回库内容」；直连表 token 时无返回 */
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const productName = useProductName();
  const grid = usePublicGridData(access);
  // 公开网格恒只读：给 CellRenderer 一份 viewer 权限集（与后端只读裁剪一致）。
  const perms = useMemo(() => permissionsForRole("viewer"), []);

  if (grid.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }

  if (grid.isError || grid.columns.length === 0) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-gx-bg text-center">
        <Icon name="lock" size={32} className="text-gx-text-hint" />
        <div className="text-gx-15 font-semibold text-gx-text-primary">该数据表未包含在本次分享范围内</div>
        <div className="text-gx-13 text-gx-text-tertiary">链接可能已失效，或这张表已被分享者关闭。</div>
        <button
          type="button"
          onClick={() => navigate("/login")}
          className="mt-2 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-2 text-gx-13 text-gx-text-secondary hover:bg-gx-bg"
        >
          返回{productName}
        </button>
      </div>
    );
  }

  const { pager } = grid;

  return (
    <div className="flex h-screen flex-col bg-gx-bg">
      <header className="flex shrink-0 items-center gap-2 border-b border-gx-separator bg-gx-surface px-4 py-2.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="返回分享内容"
            className="inline-flex h-7 w-7 items-center justify-center rounded-gx-sm text-gx-text-secondary hover:bg-gx-bg"
          >
            <Icon name="chevronLeft" size={16} />
          </button>
        )}
        <Icon name="table" size={15} className="shrink-0 text-gx-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-gx-14 font-semibold text-gx-text-primary">
          {titleOverride || grid.title || "数据表"}
        </span>
        {grid.baseName && (
          <span className="shrink-0 text-gx-12 text-gx-text-hint">{grid.baseName}</span>
        )}
        {grid.viewName && (
          <span className="shrink-0 rounded-gx-sm bg-gx-bg px-1.5 py-0.5 text-gx-11 text-gx-text-tertiary">
            {grid.viewName}
          </span>
        )}
        <span className="inline-flex shrink-0 items-center gap-1 rounded-gx-sm bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-tertiary">
          <Icon name="eye" size={11} />
          仅可见
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {grid.records.length === 0 ? (
          <div className="flex h-full min-h-[120px] items-center justify-center px-3 text-gx-12 text-gx-text-hint">
            暂无记录
          </div>
        ) : (
          <table className="w-full border-collapse text-gx-12">
            <thead>
              <tr className="bg-gx-table-header">
                {grid.columns.map((f) => (
                  <th
                    key={f.id}
                    style={{ maxWidth: MAX_COL_PX }}
                    className="sticky top-0 z-10 truncate border-b border-gx-hairline bg-gx-table-header px-3 py-2 text-left text-gx-11 font-medium text-gx-text-tertiary"
                  >
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.records.map((rec) => (
                <tr key={rec.id} className="border-b border-gx-hairline last:border-b-0">
                  {grid.columns.map((f) => (
                    <td
                      key={f.id}
                      style={{ height: 34, maxWidth: MAX_COL_PX }}
                      className="overflow-hidden px-3 text-gx-text-primary"
                    >
                      <CellRenderer
                        value={cellVal(rec, f.id) as CellValue}
                        field={f}
                        record={rec}
                        permissions={perms}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 分页：上一页 / 下一页 + 区间与总数（纯只读，无新增入口） */}
      <div className="flex shrink-0 items-center gap-3 border-t border-gx-hairline bg-gx-surface px-4 py-2 text-gx-11 text-gx-text-hint">
        <span className="min-w-0 flex-1 truncate">
          第 {pager.from}–{pager.to} 条 · 共 {pager.count} 条
          {grid.degraded ? " · 分享档位已降级为只读" : ""}
        </span>
        <button
          type="button"
          onClick={grid.prevPage}
          disabled={!pager.canPrev || grid.paging}
          aria-label="上一页"
          className="inline-flex h-7 w-7 items-center justify-center rounded-gx-sm border border-gx-border text-gx-text-secondary hover:bg-gx-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <button
          type="button"
          onClick={grid.nextPage}
          disabled={!pager.canNext || grid.paging}
          aria-label="下一页"
          className="inline-flex h-7 w-7 items-center justify-center rounded-gx-sm border border-gx-border text-gx-text-secondary hover:bg-gx-bg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  );
}

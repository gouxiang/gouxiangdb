// apps/web/src/features/kb/PublicBaseShell.tsx
// 库（base）级公开分享的「外壳落地页」（外部人免登录，只读）。
//
// 一条库分享链接只暴露：库名 + 该库内【自身单独开启了分享且带 token】的数据表卡片，
// 不含任何记录数据。点卡片才进 /s/:baseToken/t/:tableId 的单表只读网格。
// 安全口径：只渲染带 token 的表（openableShareTables fail-closed 过滤），不枚举未分享的表。

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import { EntityIcon } from "../../components/EntityIconPicker";
import { Spinner } from "../../components/ui";
import type { PublicBaseShareDTO } from "../../api/client";
import { openableShareTables, baseTableHref } from "./public-share-model";
import { useProductName } from "../branding/useBranding";

export function PublicBaseShell({
  share,
  isLoading,
  isError,
  onOpenTable,
}: {
  share: PublicBaseShareDTO | undefined;
  isLoading: boolean;
  isError: boolean;
  /** 选中某张表（交给父级切换到表网格，保持路由在 PublicSharePage 内驱动） */
  onOpenTable?: (tableId: string) => void;
}) {
  const navigate = useNavigate();
  const productName = useProductName();
  const tables = useMemo(() => openableShareTables(share?.tables ?? []), [share?.tables]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }

  if (isError || !share) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-gx-bg text-center">
        <Icon name="link" size={32} className="text-gx-text-hint" />
        <div className="text-gx-15 font-semibold text-gx-text-primary">分享链接已失效或被取消</div>
        <div className="text-gx-13 text-gx-text-tertiary">该链接可能已被分享者关闭，或内容已被删除。</div>
        <button
          type="button"
          onClick={() => navigate("/login")}
          className="mt-2 rounded-gx-lg bg-gx-accent px-4 py-2 text-gx-13 font-medium text-white hover:brightness-95"
        >
          返回{productName}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gx-bg">
      <header className="flex items-center gap-2 border-b border-gx-separator bg-gx-surface px-6 py-3">
        <Icon name="database" size={18} className="shrink-0 text-gx-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-gx-15 font-semibold text-gx-text-primary">
          {share.base.name}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-gx-sm bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-tertiary">
          <Icon name="eye" size={11} />
          仅可见
        </span>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-gx-13 text-gx-text-secondary">分享的数据表</h1>
        {tables.length === 0 ? (
          <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-gx-xl border border-dashed border-gx-border bg-gx-surface px-6 py-16 text-center">
            <Icon name="table" size={28} className="text-gx-text-hint" />
            <div className="text-gx-13 font-medium text-gx-text-secondary">还没有可查看的数据表</div>
            <div className="text-gx-12 text-gx-text-hint">分享者尚未在这个数据库中开放任何数据表。</div>
          </div>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {tables.map((t) => {
              const href = baseTableHref(share.token, t.id);
              const go = () => (onOpenTable ? onOpenTable(t.id) : navigate(href));
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={go}
                    className="group flex w-full items-center gap-3 rounded-gx-xl border border-gx-hairline bg-gx-surface px-4 py-3.5 text-left shadow-gx-card transition-colors duration-150 hover:border-gx-border hover:bg-gx-row-hover"
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-gx-lg bg-gx-bg text-gx-text-secondary">
                      <EntityIcon
                        entity={{ icon: t.icon, iconColor: null }}
                        fallback={{ name: "table" as IconName }}
                        size={18}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-gx-13 font-medium text-gx-text-primary">
                        {t.name}
                      </span>
                      <span className="text-gx-11 text-gx-text-hint">数据表</span>
                    </span>
                    <Icon
                      name="chevronRight"
                      size={16}
                      className="shrink-0 text-gx-text-hint transition-transform duration-150 group-hover:translate-x-0.5"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

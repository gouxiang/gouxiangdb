// apps/web/src/features/shell/AppShell.tsx
// 两栏骨架：左侧 Sidebar + 右侧（TopBar 或简化标题栏）+ Outlet
// 全局快捷键 Cmd/Ctrl+K 打开 SearchDialog；路由 layout 由 App.tsx 包裹 RequireAuth

import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { Sidebar } from "../sidebar/Sidebar";
import { TopBar } from "./TopBar";
import { SearchDialog } from "../search/SearchDialog";
import { Icon } from "../../components/icons";

export default function AppShell() {
  const { baseId, tableId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);

  const isSettings = location.pathname.includes("/settings");
  const isTrash = location.pathname.includes("/trash");
  const isContacts = location.pathname.startsWith("/workspace/contacts");
  const hasTable = !!tableId;

  // 全局快捷键：Cmd/Ctrl + K 打开搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen bg-gx-bg">
      <Sidebar onOpenSearch={() => setSearchOpen(true)} />

      <div className="flex min-w-0 flex-1 flex-col">
        {hasTable ? (
          <TopBar />
        ) : (
          <div className="flex h-12 items-center gap-1.5 border-b border-gx-separator bg-gx-surface px-3">
            {isContacts ? (
              <>
                <Icon name="building" size={16} className="text-gx-text-tertiary" />
                <span className="text-gx-13 font-medium text-gx-text-primary">通讯录</span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate(`/base/${baseId}`)}
                  className="rounded-gx-sm p-1 text-gx-text-tertiary hover:bg-gx-bg"
                  title="返回"
                >
                  <Icon name="chevronLeft" size={16} />
                </button>
                <span className="text-gx-13 font-medium text-gx-text-primary">
                  {isTrash ? "回收站" : "设置"}
                </span>
              </>
            )}
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          <Outlet />
        </div>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

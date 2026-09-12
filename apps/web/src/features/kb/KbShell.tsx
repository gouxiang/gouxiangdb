// apps/web/src/features/kb/KbShell.tsx
// 知识库布局壳：左 KbSidebar + 右 Outlet。
// 全局快捷键 Cmd/Ctrl+K 打开统一 SearchDialog（跨数据库记录 + 知识库文档/画布），
// 与数据表 AppShell 行为一致。

import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { KbSidebar } from "./KbSidebar";
import { SearchDialog } from "../search/SearchDialog";
import "./kb.css";

export default function KbShell() {
  const [searchOpen, setSearchOpen] = useState(false);

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
      <KbSidebar onOpenSearch={() => setSearchOpen(true)} />
      <div className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

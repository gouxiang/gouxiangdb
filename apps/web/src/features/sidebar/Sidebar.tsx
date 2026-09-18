// apps/web/src/features/sidebar/Sidebar.tsx
// 左侧栏：Base 切换 + 数据表列表 + 底部（回收站/设置/用户）
// 视觉 1:1 复刻 v1 SidebarView；颜色全部走 gx-* token

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useBases,
  useBase,
  useTables,
  useGXMutations,
} from "../../api/hooks";
import { AVATAR_PALETTE } from "@gx/design-tokens";
import { useAuthStore } from "../../store/auth";
import { Badge, Input, Menu, MenuDivider, MenuItem, Modal, Popover, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { LibrarySwitcher } from "../../components/LibrarySwitcher";
import { PersonalCenterDrawer } from "../settings/PersonalCenterDrawer";
import { DetailLayoutEditor } from "../detail/DetailLayout";

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export function Sidebar({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const navigate = useNavigate();
  const { baseId, tableId } = useParams();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const { data: tables } = useTables(baseId ?? null);
  const baseQ = useBase(baseId ?? null);
  const perms = baseQ.data?.permissions;
  const canManageSchema = perms?.canManageSchema ?? false;

  const m = useGXMutations();

  const [newName, setNewName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [personalCenterOpen, setPersonalCenterOpen] = useState(false);

  /**
   * 打开「编辑表单」：导航到目标表并带 ?design=1，由 ViewRouter 挂载全屏表单设计器。
   * 必须用 URL query 而非组件 state——App 层 ErrorBoundary 以 pathname 为 key，
   * 跨表 navigate 会卸载重挂 AppShell/Sidebar，组件内 state（designerFor）会被重置，
   * 导致「编辑 B 表保存后跳回 A 表」（旧实现模态盖在 A 表页、状态又在重挂时丢失）。
   * query 不进 pathname、不触发 remount，跨表/同表/刷新都能正确在目标表打开并停留。
   */
  function openFormDesigner(tid: string) {
    if (!baseId) return;
    navigate(`/base/${baseId}/table/${tid}?design=1`);
  }

  async function createTable() {
    if (!newName.trim() || !baseId) return;
    try {
      const t = await m.createTable.mutateAsync({ baseId, name: newName.trim(), withDefaults: true });
      setNewName("");
      setShowNew(false);
      navigate(`/base/${baseId}/table/${t.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建失败", "error");
    }
  }

  async function renameTable() {
    if (!renaming || !renaming.name.trim()) return;
    try {
      await m.updateTable.mutateAsync({ tableId: renaming.id, data: { name: renaming.name.trim() } });
      setRenaming(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    }
  }

  async function duplicateTable(id: string, withData: boolean) {
    try {
      await m.duplicateTable.mutateAsync({ tableId: id, withData });
      toast("已复制数据表", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "复制失败", "error");
    }
  }

  async function clearTable(id: string) {
    try {
      await m.clearTable.mutateAsync({ tableId: id });
      toast("已清空数据", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "清空失败", "error");
    }
  }

  async function deleteTable(id: string) {
    if (!baseId) return;
    try {
      await m.deleteTable.mutateAsync({ tableId: id, baseId });
      if (id === tableId) navigate(`/base/${baseId}`);
      toast("已删除数据表", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  return (
    <aside className="flex h-full w-60 flex-col border-r border-gx-separator bg-gx-bg">
      {/* 统一库切换（数据库 + 知识库） */}
      <div className="border-b border-gx-separator p-2">
        <LibrarySwitcher active={{ kind: "base", id: baseId ?? null }} />
      </div>

      {/* 搜索框：点击打开全局搜索 */}
      <div className="px-2 py-2">
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex w-full items-center gap-2 rounded-gx-lg border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg"
        >
          <Icon name="search" size={14} />
          <span className="flex-1 text-left">搜索</span>
          <span className="rounded bg-gx-bg px-1 text-gx-11 text-gx-text-hint">⌘K</span>
        </button>
      </div>

      {/* 数据表列表 */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1">
        {!canManageSchema && (
          <div className="mb-1 px-2 text-gx-11 text-gx-text-hint">数据表</div>
        )}
        {(tables ?? []).map((t) => {
          const active = t.id === tableId;
          return (
            <div key={t.id} className="relative">
              <button
                type="button"
                onClick={() => navigate(`/base/${baseId}/table/${t.id}`)}
                className={[
                  // R-N-09：选中态 = 白底卡片 + 圆角 8 + accent 600 字，**不用左侧色条**
                  "flex w-full items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left text-gx-13 transition-colors",
                  active ? "bg-white font-semibold text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover",
                ].join(" ")}
              >
                <Icon
                  name="table"
                  size={14}
                  className={`shrink-0 ${active ? "text-gx-accent" : "opacity-70"}`}
                />
                <span className="flex-1 truncate">{t.name}</span>
                {t.recordCount > 0 && <Badge>{t.recordCount}</Badge>}
                {canManageSchema && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === t.id ? null : t.id);
                    }}
                    className="rounded p-0.5 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
                  >
                    <Icon name="more" size={14} />
                  </span>
                )}
              </button>

              <Popover open={menuFor === t.id} onClose={() => setMenuFor(null)} align="right" width={200}>
                <Menu width={200}>
                  <MenuItem icon="edit" label="重命名" onClick={() => { setMenuFor(null); setRenaming({ id: t.id, name: t.name }); }} />
                  <MenuItem
                    icon="form"
                    label="编辑表单"
                    description="进入表单设计器"
                    onClick={() => {
                      setMenuFor(null);
                      void openFormDesigner(t.id);
                    }}
                  />
                  <MenuItem icon="copy" label="复制表（含数据）" onClick={() => { setMenuFor(null); duplicateTable(t.id, true); }} />
                  <MenuItem icon="copy" label="复制表（不含数据）" onClick={() => { setMenuFor(null); duplicateTable(t.id, false); }} />
                  <MenuItem icon="trash" label="清空数据" danger onClick={() => { setMenuFor(null); clearTable(t.id); }} />
                  <MenuDivider />
                  <MenuItem icon="trash" label="删除" danger onClick={() => { setMenuFor(null); deleteTable(t.id); }} />
                </Menu>
              </Popover>
            </div>
          );
        })}

        {/* 新建数据表 */}
        <div className="px-1.5 pt-1">
          {showNew ? (
            <div className="flex items-center gap-1 rounded-gx-sm border border-gx-border bg-gx-surface px-1 py-1">
              <Input
                autoFocus
                placeholder="表名（Enter 创建 / Esc 取消）"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createTable();
                  if (e.key === "Escape") { setShowNew(false); setNewName(""); }
                }}
                className="flex-1 border-0 bg-transparent px-1 py-0 text-gx-13 focus:outline-none focus:ring-0"
              />
              <button
                type="button"
                aria-label="创建"
                title="创建（Enter）"
                disabled={!newName.trim()}
                className="inline-flex items-center justify-center rounded-gx-sm bg-gx-accent px-2 py-1 text-gx-12 text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={createTable}
              >
                <Icon name="check" size={13} />
              </button>
              <button
                type="button"
                aria-label="取消"
                title="取消（Esc）"
                className="inline-flex items-center justify-center rounded-gx-sm px-1.5 py-1 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
                onClick={() => { setShowNew(false); setNewName(""); }}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canManageSchema}
              title={canManageSchema ? "新建数据表" : "无管理结构权限"}
              onClick={() => setShowNew(true)}
              className="w-full rounded-gx-sm px-2 py-1.5 text-left text-gx-12 text-gx-text-tertiary hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              + 新建数据表
            </button>
          )}
        </div>
      </div>

      {/* 底部：回收站 / 设置 / 用户 */}
      <div className="border-t border-gx-separator p-1.5">
        <button
          type="button"
          onClick={() => navigate(`/base/${baseId}/trash`)}
          className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-gx-13 text-gx-text-primary hover:bg-gx-row-hover"
        >
          <Icon name="trash" size={14} />
          <span>回收站</span>
        </button>
        <button
          type="button"
          onClick={() => navigate("/workspace/contacts")}
          className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-gx-13 text-gx-text-primary hover:bg-gx-row-hover"
        >
          <Icon name="building" size={14} />
          <span>通讯录</span>
        </button>
        <button
          type="button"
          onClick={() => navigate(`/base/${baseId}/settings`)}
          className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-gx-13 text-gx-text-primary hover:bg-gx-row-hover"
        >
          <Icon name="settings" size={14} />
          <span>设置</span>
        </button>

        <div className="relative mt-1 border-t border-gx-separator pt-1.5">
          <button
            type="button"
            onClick={() => setPersonalCenterOpen(true)}
            className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 hover:bg-gx-row-hover"
            title="打开个人中心"
            aria-label="打开个人中心"
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gx-11 font-semibold text-white"
              style={{ backgroundColor: avatarColor(user?.displayName ?? user?.email ?? "?") }}
            >
              {(user?.displayName ?? user?.email ?? "?").charAt(0).toUpperCase()}
            </span>
            <span className="flex-1 truncate text-left text-gx-12 text-gx-text-primary">
              {user?.displayName ?? user?.email}
            </span>
            <Icon name="settings" size={14} className="text-gx-text-tertiary" />
          </button>
        </div>
      </div>

      {/* 重命名 Modal */}
      <Modal
        open={!!renaming}
        title="重命名数据表"
        onClose={() => setRenaming(null)}
        footer={
          <>
            <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setRenaming(null)}>
              取消
            </button>
            <button
              className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
              onClick={renameTable}
            >
              保存
            </button>
          </>
        }
      >
        <Input
          autoFocus
          value={renaming?.name ?? ""}
          onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
          onKeyDown={(e) => e.key === "Enter" && renameTable()}
        />
      </Modal>

      {/* 个人中心 Drawer（点击左下角头像或设置图标打开） */}
      <PersonalCenterDrawer open={personalCenterOpen} onClose={() => setPersonalCenterOpen(false)} />

    </aside>
  );
}

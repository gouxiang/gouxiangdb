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
import { Badge, Input, Menu, MenuDivider, MenuItem, Modal, Popover, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
// 阶段 4：删除统一走 L2 确认 + 撤销 toast（R-D-23 / R-I-08 / R-D-22）
import { confirmSoftDelete } from "../../components/feedback";
import { toastDeleted } from "../../components/interaction";
import { LibrarySwitcher } from "../../components/LibrarySwitcher";
import { EntityIconPicker, resolvedEntityColor, resolveEntityIcon } from "../../components/EntityIconPicker";
import { DetailLayoutEditor } from "../detail/DetailLayout";

export function Sidebar({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const navigate = useNavigate();
  const { baseId, tableId } = useParams();

  const { data: tables } = useTables(baseId ?? null);
  const baseQ = useBase(baseId ?? null);
  const perms = baseQ.data?.permissions;
  const canManageSchema = perms?.canManageSchema ?? false;

  const m = useGXMutations();

  const [newName, setNewName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

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

  /**
   * 数据表「图标与颜色」：挂在既有的行内重命名弹窗里（入口已由 canManageSchema 把住），
   * 不再新增一套菜单/弹窗开关。选图标或选色即写库，失败由 EntityIconPicker 统一 toast。
   */
  const renamingTable = (tables ?? []).find((t) => t.id === renaming?.id) ?? null;

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

  // 阶段 4 · R-D-23 L2（软删除进回收站，可恢复）+ R-I-08（toast 带撤销）
  async function deleteTable(id: string) {
    if (!baseId) return;
    const name = (tables ?? []).find((t) => t.id === id)?.name ?? "该数据表";
    const ok = await confirmSoftDelete({
      title: `删除数据表「${name}」`,
      confirmText: "删除数据表",
      description: "数据表会移入回收站，30 天内可恢复。",
    });
    if (!ok) return;
    try {
      await m.deleteTable.mutateAsync({ tableId: id, baseId });
      if (id === tableId) navigate(`/base/${baseId}`);
      toastDeleted({
        message: `已删除数据表「${name}」`,
        restoredMessage: `已恢复数据表「${name}」`,
        onUndo: () => m.restoreTrash.mutateAsync({ id, kind: "table", baseId }),
      });
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
          // 表列表行图标：未自定义时仍是 table + 既有前景色（active accent / 常态 opacity-70）
          const rowIcon = resolveEntityIcon(t, { name: "table" });
          const rowIconColor = resolvedEntityColor(t);
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
                  name={rowIcon.name}
                  size={14}
                  className={`shrink-0 ${active ? "text-gx-accent" : "opacity-70"}`}
                  style={rowIconColor ? { color: rowIconColor } : undefined}
                />
                <span className="flex-1 truncate">{t.name}</span>
                {t.recordCount > 0 && <Badge>{t.recordCount}</Badge>}
                {canManageSchema && (
                  <span
                    role="button"
                    tabIndex={0}
                    // P3-a11y：只有图标、无可见文本，必须给可访问名称且说明管的是哪张表
                    aria-label={`${t.name} 表操作菜单`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === t.id}
                    title="表操作菜单"
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

      {/* 底部：回收站 / 通讯录 / 设置
          （交互治理第一批：原先右下角的「个人信息」入口已下线，个人信息与登出统一走顶栏个人中心抽屉） */}
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
        {/* 帮助中心：与新壳底部固定区同一入口（静态项，不看角色），旧壳回退态下同样可达 */}
        <button
          type="button"
          onClick={() => navigate("/help")}
          className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-gx-13 text-gx-text-primary hover:bg-gx-row-hover"
        >
          <Icon name="help" size={14} />
          <span>帮助中心</span>
        </button>
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
        <div className="mt-3 flex items-center gap-2 border-t border-gx-separator pt-3">
          {renamingTable && canManageSchema ? (
            <EntityIconPicker
              icon={renamingTable.icon}
              iconColor={renamingTable.iconColor}
              defaultIcon="table"
              ariaLabel="数据表图标与颜色"
              onChange={(next) =>
                m.updateTable.mutateAsync({
                  tableId: renamingTable.id,
                  data: { icon: next.icon, iconColor: next.iconColor },
                })
              }
            />
          ) : null}
          <span className="text-gx-12 text-gx-text-hint">
            图标与颜色即时生效；名称仍需点「保存」。
          </span>
        </div>
      </Modal>
    </aside>
  );
}

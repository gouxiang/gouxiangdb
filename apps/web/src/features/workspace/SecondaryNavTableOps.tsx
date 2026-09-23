// 表能力回挂 L2（第四批 · 丢失入口恢复之一）。
//
// 第三批导航重构把 L2 换成 SecondaryNav 之后，旧壳 Sidebar（features/sidebar/Sidebar.tsx）
// 已无任何引用点，挂在它上面的表操作全部失联。这里把同一批能力接回 L2：
//   面板头  「+ 新建数据表」
//   表行菜单 重命名 / 编辑表单 / 复制表（含数据） / 复制表（不含数据） / 清空数据 / 删除表
//
// 复用而非复制：全部走 api/hooks 的 useGXMutations（createTable / updateTable /
// duplicateTable / clearTable / deleteTable / restoreTrash）与 useBase 的权限，
// 与旧壳 Sidebar、现役 TopBar 同源；确认弹窗复用 feedback.tsx 的既有危险分级
// （confirm-firewall: feedback 的 L2 通用确认；表级动作走 confirm-table 的 L3 预设），不新造一套。
//
// 权限口径：canManageSchema 为假时**不渲染**入口（不是 disabled 假装禁用）——
// 与 KbHomePage「新建文档/画布」、GridView「表图标与颜色」同一套口径。
//
// 表名同库唯一（产品拍板）：输入侧即时校验是第一道，后端 409「表名「X」已存在」是第二道。
// 判重逻辑抽到 lib/table-name.ts（纯函数、可单测），本文件只负责接线与渲染；
// 列表取 useTables(baseId) —— 与 L2 行列表同一 queryKey，不新增请求。

import { useState, type ReactNode } from "react";
import { useBase, useGXMutations, useTables } from "../../api/hooks";
import { Icon } from "../../components/icons";
import { Input, Modal, toast } from "../../components/ui";
import { confirmClearTable, confirmDeleteTable } from "../../components/confirm-table";
import { toastDeleted } from "../../components/interaction";
import { findTableNameConflict, tableNameConflictMessage } from "./lib/table-name";
import type { RowMoreItem } from "./SecondaryNavSections";

/** 行菜单只需要 id + 名字（表行的其它字段不参与这些动作）。 */
export interface SecondaryTableRowRef {
  id: string;
  name: string;
}

export interface SecondaryTableOps {
  /** 表结构管理权限（base.permissions.canManageSchema）。 */
  canManageSchema: boolean;
  /** 面板头入口：新建数据表（含内联输入与重命名弹窗），由调用点统一渲染。 */
  panelNode: ReactNode;
  /** 表行菜单项；无权限时恒为空数组 → 行尾不渲染三点入口。 */
  rowMenuItems: (row: SecondaryTableRowRef) => RowMoreItem[];
}

export function useSecondaryTableOps({
  baseId,
  activeTableId,
  navigate,
}: {
  baseId: string | null;
  /** 当前所在表（删表后要回跳，不能停在死路由）。 */
  activeTableId: string | null;
  navigate: (to: string) => void;
}): SecondaryTableOps {
  const baseQ = useBase(baseId);
  // 与 L2 行列表（SecondaryNav）同一份查询：queryKey 相同 → react-query 复用，不重复发请求。
  const tablesQ = useTables(baseId);
  const m = useGXMutations();
  const canManageSchema = baseQ.data?.permissions?.canManageSchema ?? false;

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  // 即时判重：建表看全库；改名排除自己（同后端 assertTableNameFree 的 excludeTableId）。
  const newConflict = findTableNameConflict(tablesQ.data, newName);
  const renameConflict = renaming
    ? findTableNameConflict(tablesQ.data, renaming.name, renaming.id)
    : null;

  /**
   * 「编辑表单」：与旧壳 / DetailView 的既有能力同源 —— 带 ?design=1 跳目标表，
   * 由 App 的 TableIndexRedirect 选 detail 视图挂载全屏表单设计器。
   * 用 query 而不是组件 state：App 层 ErrorBoundary 以 pathname 为 key，
   * state 会在跨表重挂时丢失（旧实现踩过这个坑）。
   */
  const openFormDesigner = (tableId: string) => {
    if (!baseId) return;
    navigate(`/base/${baseId}/table/${tableId}?design=1`);
  };

  const createTable = () => {
    if (!baseId || !newName.trim()) return;
    // Enter 键走的是 Input 的 onKeyDown，不经过按钮的 disabled —— 这里必须再挡一次。
    if (newConflict) return;
    void m.createTable
      .mutateAsync({ baseId, name: newName.trim(), withDefaults: true })
      .then((t) => {
        setNewName("");
        setShowNew(false);
        navigate(`/base/${baseId}/table/${t.id}`);
      })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "新建失败", "error"));
  };

  const renameTable = () => {
    if (!renaming || !renaming.name.trim()) return;
    // 同上：弹窗里 Enter 提交不经过按钮的 disabled。
    if (renameConflict) return;
    void m.updateTable
      .mutateAsync({ tableId: renaming.id, data: { name: renaming.name.trim() } })
      .then(() => setRenaming(null))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "重命名失败", "error"));
  };

  const duplicateTable = (id: string, withData: boolean) => {
    void m.duplicateTable
      .mutateAsync({ tableId: id, withData })
      .then(() => toast("已复制数据表", "success"))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : "复制失败", "error"));
  };

  /** 清空数据：L3（需输入表名）——软删进回收站但无一键撤销，用强度补偿（同 TopBar）。 */
  const clearTable = (row: SecondaryTableRowRef) => {
    void confirmClearTable({ tableName: row.name }).then((ok) => {
      if (!ok) return;
      void m.clearTable
        .mutateAsync({ tableId: row.id })
        .then(() => toast("已清空数据，记录已移入回收站", "success"))
        .catch((e: unknown) => toast(e instanceof Error ? e.message : "清空失败", "error"));
    });
  };

  /**
   * 删除表：L3（需原样输入表名）——与同菜单里「清空数据」同一口径（见 confirm-table.ts 文件头）。
   * 恢复侧不变：仍是软删进回收站 + 撤销 toast（R-D-23 / R-I-08）；
   * 成功后跳回库首页，不停在已删除表的死路由上。
   */
  const deleteTable = (row: SecondaryTableRowRef) => {
    if (!baseId) return;
    // 闭包（撤销回调）里要用窄化后的非空值：参数在嵌套函数里不保留窄化。
    const bid = baseId;
    void confirmDeleteTable({ tableName: row.name }).then((ok) => {
      if (!ok) return;
      void m.deleteTable
        .mutateAsync({ tableId: row.id, baseId: bid })
        .then(() => {
          // 当前就在这张表上 → 跳库首页（App 的 BaseIndexRedirect 会落到第一张表）
          if (row.id === activeTableId) navigate(`/base/${bid}`);
          toastDeleted({
            message: `已删除数据表「${row.name}」`,
            restoredMessage: `已恢复数据表「${row.name}」`,
            onUndo: () => m.restoreTrash.mutateAsync({ id: row.id, kind: "table", baseId: bid }),
          });
        })
        .catch((e: unknown) => toast(e instanceof Error ? e.message : "删除失败", "error"));
    });
  };

  const rowMenuItems = (row: SecondaryTableRowRef): RowMoreItem[] => {
    if (!canManageSchema) return [];
    return [
      { icon: "edit", label: "重命名", onClick: () => setRenaming({ id: row.id, name: row.name }) },
      {
        icon: "form",
        label: "编辑表单",
        description: "进入表单设计器",
        onClick: () => openFormDesigner(row.id),
      },
      { icon: "copy", label: "复制表（含数据）", onClick: () => duplicateTable(row.id, true) },
      { icon: "copy", label: "复制表（不含数据）", onClick: () => duplicateTable(row.id, false) },
      { icon: "trash", label: "清空数据", danger: true, onClick: () => clearTable(row) },
      { icon: "trash", label: "删除表", danger: true, onClick: () => deleteTable(row) },
    ];
  };

  return {
    canManageSchema,
    rowMenuItems,
    panelNode: (
      <>
        {/* 面板头「+ 新建数据表」：无表结构管理权限整条不渲染（同 KbHomePage 的 canCreate 口径） */}
        {canManageSchema && (
          <div className="mt-2">
            {showNew ? (
              <div>
                <div className="flex items-center gap-1 rounded-gx-sm border border-gx-separator bg-gx-surface px-1 py-1">
                  <Input
                    autoFocus
                    placeholder="表名（Enter 创建 / Esc 取消）"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createTable();
                      if (e.key === "Escape") {
                        setShowNew(false);
                        setNewName("");
                      }
                    }}
                    className="min-w-0 flex-1 border-0 bg-transparent px-1 py-0 text-gx-12 focus:outline-none focus:ring-0"
                  />
                  <button
                    type="button"
                    aria-label="创建数据表"
                    // R-D-09：禁用必须说明原因（挂 title，鼠标悬停即得）
                    title={newConflict ? tableNameConflictMessage(newConflict) : "创建（Enter）"}
                    disabled={!newName.trim() || !!newConflict}
                    onClick={createTable}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-gx-sm text-gx-accent hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon name="check" size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="取消新建"
                    title="取消（Esc）"
                    onClick={() => {
                      setShowNew(false);
                      setNewName("");
                    }}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-gx-sm text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
                {/* 即时重名提示：红字口径同 CreatePatForm / DeptTree 的行内报错（text-gx-12 text-gx-danger） */}
                {newConflict && (
                  <p className="px-1 pt-1 text-gx-12 text-gx-danger">
                    {tableNameConflictMessage(newConflict)}
                  </p>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowNew(true)}
                title="新建数据表"
                className="flex w-full items-center gap-1 rounded-gx-sm px-1.5 py-1 text-left text-gx-12 text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
              >
                <Icon name="plus" size={12} />
                <span>新建数据表</span>
              </button>
            )}
          </div>
        )}

        <Modal
          open={!!renaming}
          title="重命名数据表"
          onClose={() => setRenaming(null)}
          footer={
            <>
              <button
                className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary"
                onClick={() => setRenaming(null)}
              >
                取消
              </button>
              <button
                className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
                // R-D-09：禁用必须说明原因；同名（非自己）时挂到 title
                title={renameConflict ? tableNameConflictMessage(renameConflict) : undefined}
                disabled={!renaming?.name.trim() || !!renameConflict}
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
          {/* 同上口径：改名命中别的已存在表名时即时提示（排除自己，见 lib/table-name） */}
          {renameConflict && (
            <p className="pt-1.5 text-gx-12 text-gx-danger">
              {tableNameConflictMessage(renameConflict)}
            </p>
          )}
        </Modal>
      </>
    ),
  };
}

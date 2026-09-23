// apps/web/src/features/settings/TableStatRow.tsx
// 库设置页「数据表」列表的一行：表名 + 字段数 + 记录数 + 增删清空操作。
//
// 从 SettingsPage.tsx 抽出（该文件此前 362 行、超单文件 300 行的门禁；抽出本行组件后
// 回到 300 以内）。纯搬运，零行为变化。

import { useNavigate } from "react-router-dom";
import { useFields, useGXMutations } from "../../api/hooks";
import { Button, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { confirmClearTable, confirmDeleteTable } from "../../components/confirm-table";
import { toastDeleted } from "../../components/interaction";

export function TableStatRow({ baseId, tableId, name, recordCount, canManageSchema }: {
  baseId: string;
  tableId: string;
  name: string;
  recordCount: number;
  canManageSchema: boolean;
}) {
  const navigate = useNavigate();
  const { data: fields } = useFields(tableId);
  const m = useGXMutations();

  // R-D-23 L3（需原样输入表名）+ R-I-08（toast 带撤销）：
  // 与同一行的「清空」同一强度——删表不比清空轻，不能点两下就走。
  async function removeTable() {
    if (!baseId) return;
    const ok = await confirmDeleteTable({ tableName: name });
    if (!ok) return;
    try {
      await m.deleteTable.mutateAsync({ tableId, baseId });
      navigate(`/base/${baseId}`);
      toastDeleted({
        message: `已删除数据表「${name}」`,
        restoredMessage: `已恢复数据表「${name}」`,
        onUndo: () => m.restoreTrash.mutateAsync({ id: tableId, kind: "table", baseId }),
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  // 阶段 4 · R-D-23 L3：清空是软删进回收站，但服务端不回 id 列表 → 做不出一键撤销，
  // 用「输入表名确认」的强度补偿（与顶栏同一口径）。
  async function clearTable() {
    if (!baseId) return;
    const ok = await confirmClearTable({ tableName: name });
    if (!ok) return;
    try {
      await m.clearTable.mutateAsync({ tableId });
      toast("已清空数据，记录已移入回收站", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "清空失败", "error");
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-gx-separator px-3 py-2.5">
      <Icon name="table" size={15} className="text-gx-text-tertiary" />
      <button
        type="button"
        onClick={() => navigate(`/base/${baseId}/table/${tableId}`)}
        className="flex-1 text-left text-gx-13 text-gx-text-primary hover:text-gx-accent"
      >
        {name}
      </button>
      <span className="text-gx-12 text-gx-text-tertiary">字段 {fields?.length ?? 0}</span>
      <span className="text-gx-12 text-gx-text-tertiary">记录 {recordCount}</span>
      {canManageSchema && (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => m.duplicateTable.mutate({ tableId })}>
            复制
          </Button>
          <Button size="sm" variant="ghost" className="text-gx-danger" onClick={() => void clearTable()}>
            清空
          </Button>
          <Button size="sm" variant="ghost" className="text-gx-danger" onClick={() => void removeTable()}>
            删除
          </Button>
        </div>
      )}
    </div>
  );
}

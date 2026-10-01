// apps/web/src/features/designer/sections/ViewDangerActions.tsx
// 右栏底部操作区（跨菜单常驻，渲染在右栏内容末尾）：
//   · 重置为默认视图 resetViewPrefs（所有成员可用；userPrefs===null 禁用）
//   · 危险区：复制视图 duplicateView / 删除视图 deleteView（至少保留一个视图）
//
// 删除走 confirmIrreversible 二次确认，确认后跳回表首页。复制/删除需表结构管理权限。

import { useNavigate, useParams } from "react-router-dom";
import type { PermissionSet, ViewDTO } from "@gx/shared-types";
import { Button, toast } from "../../../components/ui";
import { confirmIrreversible } from "../../../components/feedback";
import { useGXMutations, useViews } from "../../../api/hooks";

export interface ViewDangerActionsProps {
  view: ViewDTO;
  tableId: string;
  permissions: PermissionSet;
  onClose: () => void;
}

export default function ViewDangerActions({
  view,
  tableId,
  permissions,
  onClose,
}: ViewDangerActionsProps) {
  const { baseId } = useParams();
  const navigate = useNavigate();
  const { data: views } = useViews(tableId);
  const m = useGXMutations();

  const canSchema = permissions.canManageSchema;
  const onlyOne = (views?.length ?? 1) <= 1;

  const resetPrefs = async () => {
    if (view.userPrefs === null) return;
    try {
      await m.resetViewPrefs.mutateAsync({ viewId: view.id, tableId });
      toast("已恢复视图默认设置", "success");
    } catch (err) {
      toast((err as Error).message || "重置失败", "error");
    }
  };

  const duplicate = async () => {
    try {
      await m.duplicateView.mutateAsync({ viewId: view.id, tableId });
      toast("已复制视图", "success");
      onClose();
    } catch (err) {
      toast((err as Error).message || "复制失败", "error");
    }
  };

  const remove = async () => {
    if (onlyOne) return;
    const ok = await confirmIrreversible({
      title: "删除视图",
      confirmText: "删除视图",
      description: `视图「${view.name}」会被删除，此操作不可撤销。至少要保留一个视图。`,
    });
    if (!ok) return;
    try {
      await m.deleteView.mutateAsync({ viewId: view.id, tableId });
      toast("已删除视图", "success");
      navigate(`/base/${baseId}/table/${tableId}`);
      onClose();
    } catch (err) {
      toast((err as Error).message || "删除失败", "error");
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-gx-separator pt-4">
      <Button
        variant="secondary"
        block
        disabled={view.userPrefs === null}
        onClick={() => void resetPrefs()}
        title={view.userPrefs === null ? "当前为默认视图" : undefined}
      >
        重置为默认视图
      </Button>

      <div className="flex flex-col gap-2">
        <div className="text-gx-11 font-medium text-gx-text-hint">危险操作</div>
        <Button
          variant="secondary"
          block
          disabled={!canSchema}
          onClick={() => void duplicate()}
        >
          复制视图
        </Button>
        <Button
          variant="danger"
          block
          disabled={!canSchema || onlyOne}
          onClick={() => void remove()}
          title={onlyOne ? "至少保留一个视图" : undefined}
        >
          {onlyOne ? "删除视图（至少保留一个）" : "删除视图"}
        </Button>
        {!canSchema && (
          <div className="text-gx-11 text-gx-text-hint">无表结构管理权限</div>
        )}
      </div>
    </div>
  );
}

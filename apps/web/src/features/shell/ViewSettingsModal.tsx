// apps/web/src/features/shell/ViewSettingsModal.tsx
// 顶栏「视图设置」Modal：把 designer/ViewSettingsPanel 真正接进来
//
// 背景：TopBar 里原本只有一个占位 Modal（「视图设置面板将在 designer 模块接入」），
// 也就是说全仓根本没有可用的视图设置入口 —— 表单视图的提示却让用户「在视图设置中
// 调整」表单字段，指向一个不存在的地方。这里补上真实入口。
//
// 单独成文件：TopBar 已 277 行，再加取 views / 组装 permissions 会顶到 300 行公约。

import type { PermissionSet } from "@gx/shared-types";
import { Modal, Spinner } from "../../components/ui";
import { useViews } from "../../api/hooks";
import ViewSettingsPanel from "../designer/ViewSettingsPanel";

const EMPTY_PERMISSIONS: PermissionSet = {
  canManageBase: false,
  canManageSchema: false,
  canEditData: false,
  canComment: false,
  canView: true,
};

export function ViewSettingsModal({
  open,
  tableId,
  viewId,
  permissions,
  onClose,
}: {
  open: boolean;
  tableId: string;
  viewId: string;
  /** base 权限；未加载（undefined）时按最低权限渲染，面板内部会再逐项置灰 */
  permissions?: PermissionSet | null;
  onClose: () => void;
}) {
  const { data: views } = useViews(tableId);
  const view = views?.find((v) => v.id === viewId);

  return (
    <Modal open={open} title="视图设置" onClose={onClose} width={360}>
      {!view ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <ViewSettingsPanel
          view={view}
          tableId={tableId}
          permissions={permissions ?? EMPTY_PERMISSIONS}
          onClose={onClose}
          embedded
        />
      )}
    </Modal>
  );
}

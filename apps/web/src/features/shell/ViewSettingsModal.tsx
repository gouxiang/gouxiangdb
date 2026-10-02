// apps/web/src/features/shell/ViewSettingsModal.tsx
// 「视图设置」Modal：宽布局三栏（预览 + 归类菜单 + 配置内容）。
// 入口在视图标签右侧「⋯」菜单里（重命名旁边），2026-10-02 前曾是工具栏上的独立按钮。
//
// 不用 Modal 默认 title 头：传 width=960、不传 title（给 ariaLabel 做可访问名称）、flush，
// 关闭按钮由 ViewSettingsWide 在右上角自绘。本文件仍是 ViewShell 的挂载点，props 保持不变。
//
// 单独成文件：TopBar 已 277 行，再加取 views / 组装 permissions 会顶到 300 行公约。

import type { PermissionSet } from "@gx/shared-types";
import { Modal, Spinner } from "../../components/ui";
import { useViews } from "../../api/hooks";
import ViewSettingsWide from "../designer/ViewSettingsWide";

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
    <Modal
      open={open}
      onClose={onClose}
      width={960}
      ariaLabel="视图设置"
      flush
    >
      {!view ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <ViewSettingsWide
          view={view}
          tableId={tableId}
          permissions={permissions ?? EMPTY_PERMISSIONS}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

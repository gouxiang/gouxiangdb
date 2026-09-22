// apps/web/src/features/settings/role-permission/LibraryScopeRow.tsx
// 库权限一行：库名 + 「可管理 / 可见 / 可分享」三个勾选 + 最右「设置」。
//
// 三条派生规则与后端同口径：
//   ① 可管理隐含可见（勾了可管理，可见必为勾选且不可单独取消）；
//   ② 可分享隐含可见（勾了可分享，可见同样锁住）——看不见这个库就分享不了它；
//   ③ 可管理隐含分享权（canToggleShare = canManage || canShare）——勾了可管理时，
//      可分享显示为已勾且置灰。这不是「假勾」：后端确实已经给了分享权。
//
// 拆出来的原因：整块面板要保住单文件 ≤300 行，行是天然可独立的一部分。

import { Checkbox } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import type { LibraryRow } from "./library-scope-draft";

export function LibraryScopeRow({
  row,
  canEdit,
  manageable,
  visible,
  share,
  onToggleManage,
  onToggleVisible,
  onToggleShare,
  onConfigure,
}: {
  row: LibraryRow;
  canEdit: boolean;
  manageable: boolean;
  visible: boolean;
  share: boolean;
  onToggleManage: (on: boolean) => void;
  onToggleVisible: (on: boolean) => void;
  onToggleShare: (on: boolean) => void;
  /** 未传（canEdit=false）时「设置」一律置灰。 */
  onConfigure?: () => void;
}) {
  // 可见的勾选状态与「能否单独取消」由「可管理」与「可分享」共同决定：
  //   可管理隐含可见、可分享也隐含可见——看不见这个库，就谈不上管它、也谈不上分享它的内容。
  const visibleChecked = visible || manageable || share;
  const visibleLocked = manageable || share;
  // 可管理隐含分享权：必须勾、且锁住。没勾可管理时自由勾。
  const shareChecked = share || manageable;
  const shareLocked = manageable;
  const enterable = manageable || visibleChecked;
  const canConfigure = canEdit && !!onConfigure && enterable;

  const configureReason = !canEdit
    ? "你没有编辑这个角色的权限"
    : !enterable
      ? "这个库既不可见也不可管理，没有可配置的内容"
      : undefined;

  return (
    <div className="flex items-center gap-2 border-t border-gx-separator px-3 py-1.5">
      <div className="flex min-w-0 flex-1 items-center">
        <span className="truncate text-gx-13" title={row.name}>
          {row.name}
        </span>
      </div>

      <div className="flex w-16 justify-center">
        <Checkbox
          checked={manageable}
          disabled={!canEdit}
          onChange={onToggleManage}
          label={<span className="sr-only">{`${row.name}：可管理`}</span>}
        />
      </div>

      <div className="flex w-16 justify-center">
        <Checkbox
          checked={visibleChecked}
          disabled={!canEdit || visibleLocked}
          onChange={onToggleVisible}
          label={<span className="sr-only">{`${row.name}：可见`}</span>}
        />
      </div>

      <div className="flex w-16 justify-center">
        <Checkbox
          checked={shareChecked}
          disabled={!canEdit || shareLocked}
          onChange={onToggleShare}
          label={<span className="sr-only">{`${row.name}：可分享`}</span>}
        />
      </div>

      <div className="flex w-14 justify-end">
        <button
          type="button"
          onClick={canConfigure ? onConfigure : undefined}
          disabled={!canConfigure}
          title={configureReason}
          className="inline-flex items-center gap-1 rounded-gx-lg px-1.5 py-0.5 text-gx-11 text-gx-accent hover:bg-gx-accent-bg disabled:cursor-not-allowed disabled:text-gx-text-hint disabled:hover:bg-transparent"
        >
          <Icon name="settings" size={12} />
          设置
        </button>
      </div>
    </div>
  );
}

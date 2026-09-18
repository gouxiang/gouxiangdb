// M3/S9 N6 权威移动影响确认模态。
//
// 触发：NavComposer 中把实体拖到 nav group（改 nav_nodes.parentId）→ move 不带 confirmed
// 返回 409 MOVE_NEEDS_CONFIRM + impact；本模态展示影响面，用户确认后 confirmed=true 重发。
// 菜单层（menu_items）拖拽不弹本模态（AC-M3-1 边界：菜单引用层移动零副作用）。
//
// M3 willBreakInheritanceHint 恒 false（旧 members/kb_members 口径，M4 才有继承语义）。
import { Button, Modal } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { MoveImpactDTO } from "@gx/shared-types";

export interface PendingMove {
  nodeId: string;
  nodeName: string;
  targetName: string;
  newParentId: string;
  impact: MoveImpactDTO;
}

export function MoveImpactModal({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: PendingMove | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const impact = pending?.impact;
  return (
    <Modal
      open={pending !== null}
      title="移动到其他分组"
      onClose={onCancel}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy} loading={busy}>
            确认移动
          </Button>
        </>
      }
    >
      {pending && impact && (
        <div className="flex flex-col gap-3">
          <p className="text-gx-13 text-gx-text-secondary">
            将「{pending.nodeName}」移动到「{pending.targetName}」。移动会改变该节点在权威资源树中的
            位置，以下为影响面预览：
          </p>
          <ul className="flex flex-col gap-2">
            <ImpactRow icon="users" label="受影响成员" value={`${impact.affectedUserCount} 人`} hint="按当前成员口径去重" />
            <ImpactRow icon="doc" label="子树内容" value={`${impact.subtreeItemCount} 项`} hint="数据表、文档与画布（不含视图/分组）" />
            <ImpactRow icon="link" label="菜单引用" value={`${impact.shortcutCount} 处`} hint="指向该子树节点的活快捷方式" />
          </ul>
          <p className="rounded-gx-lg bg-gx-accent-bg px-3 py-2 text-gx-12 text-gx-text-tertiary">
            M3 不改变权限继承（willBreakInheritanceHint = false）；权限继承语义在后续版本生效。
          </p>
        </div>
      )}
    </Modal>
  );
}

function ImpactRow({ icon, label, value, hint }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; value: string; hint: string }) {
  return (
    <li className="flex items-start gap-2.5 rounded-gx-lg border border-gx-separator px-3 py-2">
      <Icon name={icon} size={15} className="mt-0.5 shrink-0 text-gx-text-tertiary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-gx-13 text-gx-text-secondary">{label}</span>
          <span className="font-mono text-gx-14 font-medium tabular-nums text-gx-text-primary">{value}</span>
        </div>
        <div className="mt-0.5 text-gx-11 text-gx-text-hint">{hint}</div>
      </div>
    </li>
  );
}

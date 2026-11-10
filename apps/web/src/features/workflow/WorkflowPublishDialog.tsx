// 发布流程定义二次确认弹窗（#1318 刀 C3-a2-i）：受控组件，自身不持有请求状态，便于 SSR 直测。
//
// 仅 draft 定义可发布（后端非 draft 返 409 WORKFLOW_DEF_NOT_DRAFT）；弹窗只负责确认交互，
// 真正的 mutation 与 toast 在详情主体 WorkflowDefDetail 里接线。open=false 时 Modal 直接 return null，
// 不渲染任何 DOM（与 settings 的 RevokeConfirmModal 同口径）。零 hex、图标只用 icons.tsx 已注册名。
import { Button, Modal } from "../../components/ui";
import { Icon } from "../../components/icons";

export interface WorkflowPublishDialogProps {
  open: boolean;
  /** 待发布定义名，用于弹窗内明示影响对象。 */
  defName: string;
  /** 发布请求进行中（publish.isPending）：按钮 loading、取消禁用。 */
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function WorkflowPublishDialog({
  open,
  defName,
  busy,
  onClose,
  onConfirm,
}: WorkflowPublishDialogProps) {
  return (
    <Modal
      open={open}
      title="发布流程定义"
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" icon="check" loading={busy} onClick={onConfirm}>
            确认发布
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-2 text-gx-13 text-gx-text-secondary">
        <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0 text-gx-warning" />
        <div className="flex flex-col gap-2">
          <p className="m-0">
            发布后流程将按当前编排生效，可被手动触发或按触发器自动执行。确认发布
            <span className="mx-1 font-medium text-gx-text-primary">{defName}</span>
            吗？
          </p>
          <p className="m-0 text-gx-12 text-gx-text-hint">
            发布后定义转为「已发布」，本版本不提供在线编辑或删除入口。
          </p>
        </div>
      </div>
    </Modal>
  );
}

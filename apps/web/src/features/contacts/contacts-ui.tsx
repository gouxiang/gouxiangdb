// M2/S7 通讯录共享展示小工具：账号状态徽章/文案、错误文案提取、危险操作二次确认 Modal。
import { Button, Modal } from "../../components/ui";
import type { UserAccountStatus } from "@gx/shared-types";

export const STATUS_LABEL: Record<UserAccountStatus, string> = {
  ACTIVE: "在职",
  INVITED: "待激活",
  DISABLED: "已停用",
};

export const STATUS_ORDER: UserAccountStatus[] = ["ACTIVE", "INVITED", "DISABLED"];

/** 状态徽章：文字 + 图标双表意，不仅靠颜色（可访问性）。 */
export function StatusBadge({ status }: { status: UserAccountStatus }) {
  const map: Record<UserAccountStatus, { cls: string; dot: string; label: string }> = {
    ACTIVE: { cls: "bg-gx-success-bg text-gx-success", dot: "bg-gx-success", label: STATUS_LABEL.ACTIVE },
    INVITED: { cls: "bg-gx-warning-bg text-gx-warning", dot: "bg-gx-warning", label: STATUS_LABEL.INVITED },
    DISABLED: { cls: "bg-gx-danger-bg text-gx-danger", dot: "bg-gx-danger", label: STATUS_LABEL.DISABLED },
  };
  const s = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-gx-12 font-medium ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** 从 client.ts 抛出的 ApiError/未知异常取用户可读中文文案。 */
export function errText(e: unknown, fallback = "操作失败"): string {
  if (e && typeof e === "object" && "body" in e) {
    const body = (e as { body?: { error?: string; message?: string } }).body;
    if (body?.error) return body.error;
    if (body?.message) return body.message;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** 危险操作二次确认 Modal：必须读标题并点确认按钮（文字明确），不依赖颜色单表意。 */
export function ConfirmDanger({
  open,
  title,
  body,
  confirmText,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmText: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2 text-gx-danger"><span>{title}</span></span>}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>{confirmText}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-gx-13 text-gx-text-primary">
        {body}
      </div>
    </Modal>
  );
}

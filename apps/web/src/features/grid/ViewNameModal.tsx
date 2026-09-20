// apps/web/src/features/grid/ViewNameModal.tsx
// 视图新建 / 重命名弹窗。由 ViewSwitcher 持有状态并驱动，这里只负责表单呈现。
// 单独成文件的原因：ViewSwitcher 改成选项卡形态后加上「⋯」菜单已逼近 300 行公约，
// 弹窗是它里面最大的一块且无状态，抽出来后两个文件都回到 ≤300 行。

import type { ViewType } from "@gx/shared-types";
import { VIEW_TYPES, VIEW_TYPE_LABEL } from "@gx/shared-types";
import { Icon, VIEW_ICON } from "../../components/icons";
import { Button, Input, Modal } from "../../components/ui";

export type ViewNameMode = "new" | "rename";

export interface ViewNameModalProps {
  /** null = 关闭 */
  mode: ViewNameMode | null;
  name: string;
  type: ViewType;
  busy: boolean;
  onName: (v: string) => void;
  onType: (t: ViewType) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ViewNameModal({
  mode,
  name,
  type,
  busy,
  onName,
  onType,
  onSubmit,
  onClose,
}: ViewNameModalProps) {
  return (
    <Modal
      open={mode !== null}
      title={mode === "new" ? "新建视图" : "重命名视图"}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={onSubmit}>
            {mode === "new" ? "创建" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {mode === "new" && (
          <div className="flex flex-col gap-1.5">
            <span className="text-gx-12 text-gx-text-secondary">视图类型</span>
            <div className="flex flex-wrap gap-1.5">
              {VIEW_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onType(t)}
                  className={[
                    "flex items-center gap-1.5 rounded-gx-lg border px-2 py-1 text-gx-12",
                    type === t
                      ? "border-gx-accent bg-gx-accent-bg text-gx-accent"
                      : "border-gx-border text-gx-text-primary hover:bg-gx-bg",
                  ].join(" ")}
                >
                  <Icon name={VIEW_ICON[t] ?? "grid"} size={13} />
                  {VIEW_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-gx-12 text-gx-text-secondary">视图名称</span>
          <Input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="视图名称"
            onChange={(e) => onName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

export default ViewNameModal;

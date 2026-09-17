// M5 重建索引确认弹窗：选择范围（全部 / 记录 / 文档 / 画布）二次确认后触发 POST /admin/reindex。
// 409 REINDEX_IN_PROGRESS 由父组件以中性 toast 提示，不在此弹窗报错。
import { useState } from "react";
import { Button, Modal } from "../../components/ui";
import type { ReindexRequest } from "@gx/shared-types";

export interface ReindexModalProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: ReindexRequest) => void;
}

type Scope = "all" | "record" | "doc" | "canvas";

const SCOPES: { value: Scope; label: string; hint: string }[] = [
  { value: "all", label: "全部内容", hint: "记录、文档与画布整体重建" },
  { value: "record", label: "仅表格记录", hint: "" },
  { value: "doc", label: "仅知识库文档", hint: "" },
  { value: "canvas", label: "仅画布", hint: "" },
];

export function ReindexModal({ open, busy, onClose, onConfirm }: ReindexModalProps) {
  const [scope, setScope] = useState<Scope>("all");

  const confirm = () => {
    onConfirm(scope === "all" ? {} : { type: scope });
  };

  return (
    <Modal
      open={open}
      title="重建检索索引"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={confirm} loading={busy} disabled={busy}>
            开始重建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-gx-13 text-gx-text-secondary">
        <p>重建会在后台进行，期间关键词检索照常可用，完成后语义检索结果更新为最新内容。</p>
        <div className="flex flex-col gap-1.5">
          {SCOPES.map((s) => (
            <label
              key={s.value}
              className="flex cursor-pointer items-start gap-2 rounded-gx-md border border-gx-separator p-2.5"
            >
              <input
                type="radio"
                name="reindex-scope"
                className="mt-0.5"
                checked={scope === s.value}
                onChange={() => setScope(s.value)}
              />
              <span>
                <span className="block text-gx-13 text-gx-text-primary">{s.label}</span>
                {s.hint && <span className="mt-0.5 block text-gx-12 text-gx-text-hint">{s.hint}</span>}
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

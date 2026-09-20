// L1 行尾「…」菜单里的「重命名」弹窗。
//
// 单独成文件只为守住「单文件 ≤300 行」：PrimaryNav 已经是窗口化 + 行渲染 + 折叠档
// 三件事的聚合体，再把弹窗内联进去会把它顶过上限。
//
// 写库动作由壳层以 `onRename` 注入（PrimaryNav 内不能 useMutation —— 多份 SSR 回归
// 不带 QueryClientProvider），失败在这里统一 toast，不吞异常。

import { useState } from "react";
import { Input, Modal, toast } from "../../components/ui";

export interface RenameTarget {
  kind: "base" | "kb";
  id: string;
  name: string;
}

export function PrimaryNavRenameModal({
  target,
  onClose,
  onRename,
}: {
  target: RenameTarget | null;
  onClose: () => void;
  onRename?: (kind: "base" | "kb", id: string, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(target?.name ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!target || !onRename) return;
    const next = name.trim();
    if (!next || busy) return;
    setBusy(true);
    try {
      await onRename(target.kind, target.id, next);
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title={target?.kind === "kb" ? "重命名知识库" : "重命名数据库"}
      ariaLabel="重命名"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
          >
            保存
          </button>
        </>
      }
    >
      <Input
        autoFocus
        value={name}
        aria-label="新名称"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
    </Modal>
  );
}

// L1 行尾「…」菜单里的「重命名」弹窗。
//
// 单独成文件只为守住「单文件 ≤300 行」：PrimaryNav 已经是窗口化 + 行渲染 + 折叠档
// 三件事的聚合体，再把弹窗内联进去会把它顶过上限。
//
// 保持【纯受控】：本弹窗不自己调 useBases/useKbList —— 多份 SSR 回归用
// renderToStaticMarkup 渲染 PrimaryNav（不带 QueryClientProvider），任何数据 hook
// 都会在服务端抛错。库列表与写库动作一律由壳层经 props 注入。

import { useState } from "react";
import { Input, Modal, toast } from "../../components/ui";
import {
  findLibraryNameConflict,
  libraryNameConflictMessage,
  type LibraryNameRef,
} from "./lib/library-name";

export interface RenameTarget {
  kind: "base" | "kb";
  id: string;
  name: string;
}

export function PrimaryNavRenameModal({
  target,
  bases,
  kbs,
  onClose,
  onRename,
}: {
  target: RenameTarget | null;
  /** 壳层注入的活库列表（判重用）；未注入时按无冲突处理（后端 409 兜底）。 */
  bases?: readonly LibraryNameRef[] | null;
  kbs?: readonly LibraryNameRef[] | null;
  onClose: () => void;
  onRename?: (kind: "base" | "kb", id: string, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(target?.name ?? "");
  const [busy, setBusy] = useState(false);

  // A4：两类合并判重，改名排除自己（target.id，base/kb 同口径按 id 排除）。
  const conflict = target
    ? findLibraryNameConflict(bases, kbs, name, target.id)
    : null;

  const submit = async () => {
    if (!target || !onRename) return;
    const next = name.trim();
    // Enter 提交不经过按钮的 disabled：入口再挡一次冲突。
    const hit = findLibraryNameConflict(bases, kbs, name, target.id);
    if (!next || hit || busy) return;
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
            disabled={!name.trim() || !!conflict || busy}
            onClick={() => void submit()}
          >
            保存
          </button>
        </>
      }
    >
      <div>
        <Input
          autoFocus
          value={name}
          aria-label="新名称"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
        {/* 即时重名提示：红字口径同 SecondaryNavTableOps 的行内报错 */}
        {conflict && (
          <p className="px-1 pt-1 text-gx-12 text-gx-danger">
            {libraryNameConflictMessage(conflict)}
          </p>
        )}
      </div>
    </Modal>
  );
}

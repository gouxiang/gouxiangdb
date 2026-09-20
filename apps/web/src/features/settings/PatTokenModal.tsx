// M6-FE 一次性明文令牌弹窗：大字等宽展示完整 token + 复制按钮 + 「仅显示一次」强提示。
// 关闭即焚：token 仅由父组件 state 持有（不写入浏览器本地存储或 URL），父组件 onClose 置 null。
// token 为空即不渲染（组件卸载 + Modal 关闭），保证关闭后 DOM 中不再残留明文。
import { useState } from "react";
import { Button, Modal, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { TOKEN_ONCE_WARNING } from "./pat-labels";
import { COPY_FAIL_HINT_TEXT, copyText } from "../../lib/clipboard";

export function PatTokenModal({
  token,
  name,
  onClose,
}: {
  token: string | null;
  name?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // token 为空 → 关闭且不渲染（关闭即焚的呈现层保证）。
  if (!token) return null;

  async function copy() {
    if (!token) return;
    if (await copyText(token)) {
      setCopied(true);
      toast("已复制到剪贴板", "success");
    } else {
      toast(COPY_FAIL_HINT_TEXT, "error");
    }
  }

  return (
    <Modal
      open
      title="令牌已签发"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" icon="copy" onClick={copy}>
            {copied ? "已复制" : "复制令牌"}
          </Button>
          <Button variant="primary" onClick={onClose}>
            我已保存，关闭
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2 rounded-gx-lg border border-gx-warning bg-gx-warning-bg px-3 py-2">
          <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0 text-gx-warning" />
          <span className="text-gx-12 text-gx-text-secondary">{TOKEN_ONCE_WARNING}</span>
        </div>

        {name && <div className="text-gx-12 text-gx-text-tertiary">名称：{name}</div>}

        <div className="rounded-gx-lg border border-gx-border bg-gx-bg px-3 py-3">
          <code className="block break-all font-mono text-gx-14 leading-relaxed text-gx-text-primary">
            {token}
          </code>
        </div>

        <div className="flex items-center gap-1.5 text-gx-12 text-gx-text-hint">
          <Icon name="lock" size={13} />
          仅显示一次，关闭后不可找回
        </div>
      </div>
    </Modal>
  );
}

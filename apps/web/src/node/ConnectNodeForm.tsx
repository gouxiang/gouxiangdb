// apps/web/src/node/ConnectNodeForm.tsx
// 对「已在注册表但当前无有效会话」的远端节点，输入账号密码登录并重连（DESIGN §8.1）。
// 与 AddRemoteNodeForm 的区别：不填网址、不新建条目，只针对既定 nodeId 走 connectExistingRemote。
// 同样分纯展示 View（SSR 可锁）+ 薄容器；密码仅内存透传、成功后清空、不持久化。

import { useState, type FormEvent } from "react";
import { Button, Input } from "../components/ui";
import { connectExistingRemote, type ConnectExistingPort } from "./addRemoteFlow";
import { addNodeErrorMessage, type AddNodeErrorKind } from "./nodeMessages";

export interface ConnectNodeFormViewProps {
  /** 目标节点展示名（标题）。 */
  title: string;
  /** 目标节点基址（副标题，只读展示）。 */
  baseURL: string;
  email: string;
  password: string;
  busy?: boolean;
  error?: AddNodeErrorKind | null;
  onField: (field: "email" | "password", value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function ConnectNodeFormView({
  title,
  baseURL,
  email,
  password,
  busy = false,
  error = null,
  onField,
  onSubmit,
  onCancel,
}: ConnectNodeFormViewProps) {
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <div className="min-w-0">
        <div className="truncate text-gx-14 font-medium text-gx-text-primary">连接「{title}」</div>
        <div className="truncate text-gx-12 text-gx-text-tertiary">{baseURL}</div>
      </div>

      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>账号（邮箱）</span>
        <Input
          value={email}
          disabled={busy}
          type="email"
          autoComplete="username"
          placeholder="you@example.com"
          onChange={(e) => onField("email", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>密码</span>
        <Input
          value={password}
          disabled={busy}
          type="password"
          autoComplete="current-password"
          onChange={(e) => onField("password", e.target.value)}
        />
      </label>

      {error && (
        <div
          role="alert"
          className="rounded-gx-lg bg-gx-danger-bg px-2.5 py-2 text-gx-13 text-gx-danger"
        >
          {addNodeErrorMessage(error)}
        </div>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          返回
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          {busy ? "连接中…" : "连接"}
        </Button>
      </div>
    </form>
  );
}

export interface ConnectNodeFormProps {
  nodeId: string;
  title: string;
  baseURL: string;
  port: ConnectExistingPort;
  onConnected?: (nodeId: string) => void;
  onCancel: () => void;
}

export function ConnectNodeForm({
  nodeId,
  title,
  baseURL,
  port,
  onConnected,
  onCancel,
}: ConnectNodeFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AddNodeErrorKind | null>(null);

  async function onSubmit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await connectExistingRemote({ nodeId, email, password }, port);
      if (r.kind === "connected") {
        setPassword("");
        onConnected?.(nodeId);
      } else {
        setError(r.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConnectNodeFormView
      title={title}
      baseURL={baseURL}
      email={email}
      password={password}
      busy={busy}
      error={error}
      onField={(f, v) => {
        if (f === "email") setEmail(v);
        else setPassword(v);
        if (error) setError(null);
      }}
      onSubmit={() => void onSubmit()}
      onCancel={onCancel}
    />
  );
}

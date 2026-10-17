// apps/web/src/node/AddRemoteNodeForm.tsx
// 启动器「添加并连接一个远端节点」表单（DESIGN-MACOS-APP.md §8.5 规则 #4；主设计 §7.1/§7.3）。
//
// 分两层：
//   AddRemoteNodeFormView —— 纯展示（受控 value/error/busy），node + react-dom/server 可锁
//                            结构、字段、§7.3 确定错误文案、提交中禁用态；
//   AddRemoteNodeForm     —— 薄容器，持有输入状态，提交时调 addAndConnectRemote（规范化→
//                            握手→登录→入册→连接，失败回滚都已在该纯编排器内单测覆盖）。
//
// 本组件**不含门控**：由上层启动器界面在 VITE_NODE_LAUNCHER 开启时才渲染，浏览器/fnOS 永不触达。
// 遵守前端纪律：只用 components/ui 控件 + gx-* 令牌 + 自建图标，无新依赖、无裸 fetch。

import { useState, type FormEvent } from "react";
import { Button, Input } from "../components/ui";
import {
  addAndConnectRemote,
  type AddRemoteStorePort,
} from "./addRemoteFlow";
import type { AddNodeErrorKind } from "./nodeMessages";
import { addNodeErrorMessage } from "./nodeMessages";

export interface AddRemoteFormValues {
  url: string;
  email: string;
  password: string;
  label: string;
}

export const EMPTY_ADD_REMOTE_VALUES: AddRemoteFormValues = {
  url: "",
  email: "",
  password: "",
  label: "",
};

export interface AddRemoteNodeFormViewProps {
  values: AddRemoteFormValues;
  /** 提交中（探活+登录进行中）：输入与按钮禁用、按钮走 loading 样式。 */
  busy?: boolean;
  /** 失败分类；View 用 nodeMessages 映射为确定文案。 */
  error?: AddNodeErrorKind | null;
  /** 成功连接后是否显示一次成功提示（容器可短暂展示）。 */
  succeeded?: boolean;
  onField: (field: keyof AddRemoteFormValues, value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}

/**
 * 纯展示表单。字段顺序与文案对齐主设计 §7.1（网址 / 账号 / 密码 / 可选名称）。
 * 错误条用 alert 角色，确保读屏与颜色之外的可感知（不只靠颜色表达状态）。
 */
export function AddRemoteNodeFormView({
  values,
  busy = false,
  error = null,
  succeeded = false,
  onField,
  onSubmit,
  onCancel,
}: AddRemoteNodeFormViewProps) {
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>节点网址</span>
        <Input
          value={values.url}
          disabled={busy}
          inputMode="url"
          autoComplete="off"
          placeholder="http://192.168.1.5:3001"
          onChange={(e) => onField("url", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>账号（邮箱）</span>
        <Input
          value={values.email}
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
          value={values.password}
          disabled={busy}
          type="password"
          autoComplete="current-password"
          onChange={(e) => onField("password", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>名称（可选）</span>
        <Input
          value={values.label}
          disabled={busy}
          autoComplete="off"
          placeholder="例如：家里的库"
          onChange={(e) => onField("label", e.target.value)}
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
      {succeeded && !error && (
        <div
          role="status"
          className="rounded-gx-lg bg-gx-success-bg px-2.5 py-2 text-gx-13 text-gx-success"
        >
          已连接
        </div>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          {busy ? "连接中…" : "添加并连接"}
        </Button>
      </div>
    </form>
  );
}

export interface AddRemoteNodeFormProps {
  /** 启动器仓库端口（生产传 LauncherStore；测试传 fake）。 */
  store: AddRemoteStorePort;
  /** 瘦客户端最低兼容节点版本（透传握手）；缺省仅要求版本可解析。 */
  minNodeVersion?: string;
  onConnected?: (nodeId: string, baseURL: string) => void;
  onCancel?: () => void;
}

/**
 * 容器：本地输入态 + 调用纯编排器。成功后清空密码（不保留在组件状态）、回调上层；
 * 失败把分类交给 View 显示确定文案。注册表/会话/活动源的实际变更全在 store/编排器里。
 */
export function AddRemoteNodeForm({
  store,
  minNodeVersion,
  onConnected,
  onCancel,
}: AddRemoteNodeFormProps) {
  const [values, setValues] = useState<AddRemoteFormValues>(EMPTY_ADD_REMOTE_VALUES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AddNodeErrorKind | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  function onField(field: keyof AddRemoteFormValues, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    if (error) setError(null);
  }

  async function onSubmit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSucceeded(false);
    try {
      // 成品壳内 store 提供 probe 同源转发握手（begin_probe/end_probe）；浏览器/fnOS 无此方法，
      // 传 undefined → addAndConnectRemote 缺省对显式 baseURL 直连（现网零变化）。
      const performHandshake = store.addHandshake?.(minNodeVersion);
      const result = await addAndConnectRemote(
        {
          url: values.url,
          email: values.email,
          password: values.password,
          label: values.label,
        },
        { store, minNodeVersion, ...(performHandshake ? { performHandshake } : {}) },
      );
      if (result.kind === "connected") {
        setSucceeded(true);
        // 密码不留在状态里；网址/账号/名称清空，方便继续添加下一个。
        setValues(EMPTY_ADD_REMOTE_VALUES);
        onConnected?.(result.nodeId, result.baseURL);
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AddRemoteNodeFormView
      values={values}
      busy={busy}
      error={error}
      succeeded={succeeded}
      onField={onField}
      onSubmit={() => void onSubmit()}
      onCancel={onCancel}
    />
  );
}

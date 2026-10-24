// apps/web/src/node/AddReplicaNodeForm.tsx
// 启动器第三入口「把这台电脑作为本机离线副本接入远端服务器」表单（切片 3b，可见可点接线）。
//
// 分两层 + 一个可注入纯异步编排器：
//   AddReplicaNodeFormView    —— 纯展示（受控 value/error/busy），node + react-dom/server 可锁
//                                结构、字段、§7.3 确定错误文案、提交中禁用态；
//   submitReplicaConnection   —— 不依赖 React/DOM 的纯异步编排，node 环境用 fake store 直测：
//                                新副本先复用 3a 的 addReplicaFlow 仅入册，再 store.connectReplica
//                                拉起侧车并选路；既有副本重连则跳过入册直接通电；
//   AddReplicaNodeForm        —— 薄容器，持有输入状态，提交时调上面的编排器。
//
// 令牌纪律（remoteToken 零持久化）：
//   - 令牌只活在 React 输入态与当次 connectReplica 的入参里（经 IPC 注入副本子进程 env）；
//   - 端口与编排结果的类型上都没有令牌字段，addReplica 入参也只有 {nodeId,label,remoteBaseUrl}；
//   - 成功/失败后都清空输入框里的令牌；注册表/state/storage 任何时刻都不含令牌（单测对拍 JSON）。
//
// 与添加远端不同：connectReplica 失败时刻意**不回滚**已登记的副本档案——条目保留在列表里，
// 用户改对令牌后可从该副本行直接「进入副本」重连，不必重填服务器网址/名称。
//
// 本组件不含门控：由上层启动器界面在成品壳（VITE_NODE_LAUNCHER）开启时才渲染，浏览器/fnOS 永不触达。
// 遵守前端纪律：只用 components/ui 控件 + gx-* 令牌，无新依赖、无裸 fetch、无 emoji 图标。

import { useState, type FormEvent } from "react";
import { Button, Input } from "../components/ui";
import {
  addReplicaFlow,
  type AddReplicaStorePort,
} from "./addReplicaFlow";
import type {
  AddReplicaInput,
  NodeRegistryState,
} from "./registry";
import type { AddNodeErrorKind } from "./nodeMessages";
import { addNodeErrorMessage } from "./nodeMessages";

export interface AddReplicaFormValues {
  url: string;
  remoteToken: string;
  label: string;
}

export const EMPTY_ADD_REPLICA_VALUES: AddReplicaFormValues = {
  url: "",
  remoteToken: "",
  label: "",
};

/**
 * 既有副本「重连」目标（来自列表行）。此形态下网址/名称只读预填、令牌每次重新输入，
 * 提交时跳过 addReplicaFlow（条目已在册），直接 connectReplica。
 */
export interface ExistingReplica {
  nodeId: string;
  /** 入册时规范化的裸 origin，仅供只读回显。 */
  remoteBaseUrl: string;
  label: string | null;
}

/**
 * 表单对启动器仓库所需的最小面（LauncherStore 结构上满足，测试可给 fake）。
 * 刻意对齐真实 store：addReplica 返回 **void**（仅入册 + 持久化 + 通知），
 * 与 3a addReplicaFlow 那个「返回新建条目」的登记端口不同——二者由下方编排器桥接。
 */
export interface ReplicaConnectPort {
  getState(): NodeRegistryState;
  addReplica(input: AddReplicaInput): void;
  connectReplica(
    nodeId: string,
    remoteToken: string,
  ): Promise<{ active?: { nodeId: string } | null }>;
}

export type SubmitReplicaResult =
  | { kind: "connected"; nodeId: string }
  | { kind: "form_error"; error: AddNodeErrorKind }
  | { kind: "connect_error"; nodeId: string | null; message: string };

function connectFailureMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "副本连接失败，请重试";
}

/**
 * 纯异步提交编排。令牌先做空判（不 trim、原样透传，仅判空），再分新副本/既有重连两条路。
 * 任何阶段都不把令牌写进注册表；connectReplica 失败不回滚已登记条目。
 */
export async function submitReplicaConnection(
  input: {
    url: string;
    label: string;
    remoteToken: string;
    existing?: ExistingReplica | null;
  },
  deps: { store: ReplicaConnectPort },
): Promise<SubmitReplicaResult> {
  // 1) 连接令牌必填（侧车要拿它向上游服务器鉴权同步）；空串或纯空白在发任何 IPC 前 fail-closed。
  //    判空用 trim（纯空格不可放行），但后续透传仍用**原值**——不篡改真实令牌的字节。
  if (!input.remoteToken.trim()) {
    return {
      kind: "connect_error",
      nodeId: input.existing?.nodeId ?? null,
      message: "请输入连接令牌",
    };
  }

  // 2) 既有副本重连：条目已在册，跳过登记，直接用本次令牌通电（令牌仍不落盘）。
  if (input.existing) {
    try {
      await deps.store.connectReplica(input.existing.nodeId, input.remoteToken);
      return { kind: "connected", nodeId: input.existing.nodeId };
    } catch (e) {
      return {
        kind: "connect_error",
        nodeId: input.existing.nodeId,
        message: connectFailureMessage(e),
      };
    }
  }

  // 3) 新副本：先复用 3a 的登记编排（规范化网址/名称、自动 replica-N、查重）。
  //    真实 store.addReplica 返回 void，这里把它桥接成 addReplicaFlow 期望的「返回新建条目」端口：
  //    addReplica 仅入册后，从不可变替换的最新 state 回读该条目（找不到＝契约破坏，抛错被收口 duplicate）。
  const registerPort: AddReplicaStorePort = {
    getState: () => deps.store.getState(),
    addReplica: (add) => {
      deps.store.addReplica(add);
      const created = deps.store
        .getState()
        .entries.find((entry) => entry.nodeId === add.nodeId);
      if (!created) throw new Error("副本已登记，但在列表中找不到");
      return created;
    },
  };
  const registered = addReplicaFlow(
    { url: input.url, label: input.label },
    { store: registerPort },
  );
  if (registered.kind === "error") {
    return { kind: "form_error", error: registered.error };
  }

  // 4) 登记成功后拉起副本侧车并选路。失败刻意不回滚登记（档案保留，可改令牌重连）。
  try {
    await deps.store.connectReplica(registered.nodeId, input.remoteToken);
    return { kind: "connected", nodeId: registered.nodeId };
  } catch (e) {
    return {
      kind: "connect_error",
      nodeId: registered.nodeId,
      message: connectFailureMessage(e),
    };
  }
}

export interface AddReplicaNodeFormViewProps {
  values: AddReplicaFormValues;
  /** 提交中（入册 + 拉起侧车进行中）：输入与按钮禁用、按钮走 loading 样式。 */
  busy?: boolean;
  /** 登记阶段的表单分类失败；View 用 nodeMessages 映射为确定文案。 */
  error?: AddNodeErrorKind | null;
  /** 通电阶段（含空令牌/壳侧车启动失败）的确定中文文案。 */
  connectError?: string | null;
  /** 成功通电后是否显示一次成功提示。 */
  succeeded?: boolean;
  /** 既有副本重连形态：网址/名称只读预填，只收令牌，提交跳过入册。 */
  existingReplica?: ExistingReplica | null;
  onField: (field: keyof AddReplicaFormValues, value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}

/**
 * 纯展示表单。三个受控字段：服务器网址、连接令牌（password）、可选副本名称。
 * 重连形态下网址/名称用 readOnly（不是 disabled：仍可选中复制，R-D-11），令牌每次重新输入。
 * 两条错误通道都用 alert 角色，确保读屏与颜色之外的可感知。
 */
export function AddReplicaNodeFormView({
  values,
  busy = false,
  error = null,
  connectError = null,
  succeeded = false,
  existingReplica = null,
  onField,
  onSubmit,
  onCancel,
}: AddReplicaNodeFormViewProps) {
  const reconnecting = !!existingReplica;
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>服务器网址</span>
        <Input
          value={values.url}
          disabled={busy}
          readOnly={reconnecting}
          inputMode="url"
          autoComplete="off"
          placeholder="http://192.168.1.5:3001"
          onChange={(e) => onField("url", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>连接令牌</span>
        <Input
          type="password"
          value={values.remoteToken}
          disabled={busy}
          autoComplete="off"
          placeholder="粘贴服务器管理员给的连接令牌"
          onChange={(e) => onField("remoteToken", e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-gx-13 text-gx-text-secondary">
        <span>副本名称（可选）</span>
        <Input
          value={values.label}
          disabled={busy}
          readOnly={reconnecting}
          autoComplete="off"
          placeholder="例如：办公本-副本"
          onChange={(e) => onField("label", e.target.value)}
        />
      </label>

      <p className="text-gx-12 leading-5 text-gx-text-hint">
        在这台电脑保留一份可离线使用的副本，联网后自动与上面的服务器同步。连接令牌只用于本次启动，不会被保存。
      </p>

      {error && (
        <div
          role="alert"
          className="rounded-gx-lg bg-gx-danger-bg px-2.5 py-2 text-gx-13 text-gx-danger"
        >
          {addNodeErrorMessage(error)}
        </div>
      )}
      {connectError && !error && (
        <div
          role="alert"
          className="rounded-gx-lg bg-gx-danger-bg px-2.5 py-2 text-gx-13 text-gx-danger"
        >
          {connectError}
        </div>
      )}
      {succeeded && !error && !connectError && (
        <div
          role="status"
          className="rounded-gx-lg bg-gx-success-bg px-2.5 py-2 text-gx-13 text-gx-success"
        >
          已连接，正在进入副本
        </div>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          {busy ? "正在连接…" : reconnecting ? "连接并进入" : "添加并进入"}
        </Button>
      </div>
    </form>
  );
}

export interface AddReplicaNodeFormProps {
  /** 启动器仓库端口（生产传 LauncherStore；测试传 fake）。 */
  store: ReplicaConnectPort;
  /** 传入即为既有副本重连形态（跳过入册、网址/名称只读、只收令牌）。 */
  existingReplica?: ExistingReplica | null;
  onConnected?: (nodeId: string) => void;
  onCancel?: () => void;
}

/**
 * 容器：本地输入态 + 调纯异步编排器。成功后清空令牌（重连只清令牌，新副本整表清空）并回调上层
 * 路由进该副本；登记失败走分类文案，通电失败走确定中文文案且保留已登记条目。
 */
export function AddReplicaNodeForm({
  store,
  existingReplica = null,
  onConnected,
  onCancel,
}: AddReplicaNodeFormProps) {
  const [values, setValues] = useState<AddReplicaFormValues>(() => ({
    url: existingReplica?.remoteBaseUrl ?? "",
    // 令牌绝不预填：零持久化意味着每次连接都重新输入。
    remoteToken: "",
    label: existingReplica?.label ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AddNodeErrorKind | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  function onField(field: keyof AddReplicaFormValues, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    if (error) setError(null);
    if (connectError) setConnectError(null);
  }

  async function onSubmit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConnectError(null);
    setSucceeded(false);
    try {
      const result = await submitReplicaConnection(
        {
          url: values.url,
          label: values.label,
          remoteToken: values.remoteToken,
          existing: existingReplica,
        },
        { store },
      );
      if (result.kind === "connected") {
        setSucceeded(true);
        // 令牌无论如何都清空；新副本顺带清空网址/名称便于添加下一个，重连仅清令牌。
        setValues((v) =>
          existingReplica
            ? { ...v, remoteToken: "" }
            : { ...EMPTY_ADD_REPLICA_VALUES },
        );
        onConnected?.(result.nodeId);
      } else if (result.kind === "form_error") {
        setError(result.error);
      } else {
        setConnectError(result.message);
        // 通电失败也清掉令牌输入，避免令牌长时间停留在 DOM/state 里。
        setValues((v) => ({ ...v, remoteToken: "" }));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AddReplicaNodeFormView
      values={values}
      busy={busy}
      error={error}
      connectError={connectError}
      succeeded={succeeded}
      existingReplica={existingReplica}
      onField={onField}
      onSubmit={() => void onSubmit()}
      onCancel={onCancel}
    />
  );
}

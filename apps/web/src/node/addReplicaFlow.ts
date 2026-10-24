// apps/web/src/node/addReplicaFlow.ts
// 启动器「登记一个离线副本（不连接）」的交互编排（第三入口·切片 3a）。
//
// 一次用户提交（远端服务器网址 + 可选副本名 nodeId + 可选显示名 label）走完：
//   规范化网址 → 规范化显示名 → 定副本 nodeId（显式校验 / 缺省 replica-N）→ 注册表查重
//   → store.addReplica 仅入册（不激活、不切活动指针）。
// 失败在每个阶段都收口为确定分类 AddNodeErrorKind（UI 用 nodeMessages 映射文案）。
//
// 安全 / 数据纪律：
//   - **不握手、不发任何网络请求、不连接壳**（connectReplica 是后续切片 3b 的事，本文件禁止出现）；
//   - **不收账号/密码/token**：端口与入参类型上就没有凭据字段，返回体也不含任何凭据；
//   - fail-closed：网址非法 / nodeId 越界（含中文等非白名单字符）/ 重名，一律不建条目；
//   - 只调一次 store.addReplica，且仅传 { nodeId, label, remoteBaseUrl } 三个键
//     （clientId/syncIntervalMs 缺省，不由本入口设置）；
//   - 纯逻辑、同步、可注入 store，node 环境直测，不依赖 React/DOM，不被任何现网入口 import。

import { normalizeNodeUrl } from "./resolve";
import {
  isValidReplicaNodeId,
  type AddReplicaInput,
  type NodeRegistryState,
  type StoredNodeEntry,
} from "./registry";
import { normalizeNodeLabel } from "./addRemoteFlow";
import type { AddNodeErrorKind, AddNodeFormErrorCode } from "./nodeMessages";

/** 编排器对启动器控制器所需的最小面（LauncherController 结构上满足，测试可给 fake）。 */
export interface AddReplicaStorePort {
  getState(): NodeRegistryState;
  /**
   * 仅入册一个副本：成功返回新建条目，失败（重名等）throw 中文 Error。
   * **端口刻意不含 connectReplica / 任何 token 字段**——本编排只登记、不通电。
   */
  addReplica(input: AddReplicaInput): StoredNodeEntry;
}

/** addReplicaFlow 入参。 */
export interface AddReplicaFlowInput {
  /** 副本要同步的远端服务器地址（裸 host:port 或完整 http(s)://…[/basePath]）。 */
  url: string;
  /** 可选显示名；空白等价于不填（回落默认名「本机副本」）。 */
  label?: string | null;
  /**
   * 可选副本 nodeId（白名单 ^[A-Za-z0-9._-]+$、≤64、≠"local"/"."/".."）；
   * 省略或纯空白时由 {@link defaultReplicaNodeId} 自动取 replica-1/2/3…。
   * 中文等非 ASCII 字符一律拒绝（nodeId 是壳内分键/文件路径口径，绝不收中文）。
   */
  nodeId?: string | null;
}

export interface AddReplicaDeps {
  store: AddReplicaStorePort;
}

export type AddReplicaFlowResult =
  | {
      kind: "added";
      /** 实际入册的副本 nodeId（trim 后）。 */
      nodeId: string;
      /** 入册后规范化的裸 origin（以存储条目为准，供 UI 回显）。 */
      remoteBaseUrl: string;
      /** 实际存下的显示名（null＝用默认名）。 */
      label: string | null;
      /** 新建的注册表条目（无凭据字段）。 */
      entry: StoredNodeEntry;
    }
  | { kind: "error"; error: AddNodeErrorKind };

function formFail(code: AddNodeFormErrorCode): AddReplicaFlowResult {
  return { kind: "error", error: { stage: "form", code } };
}

/** 自动副本 nodeId 前缀。 */
const DEFAULT_REPLICA_PREFIX = "replica-";

/**
 * 自定义类型守卫：把「注册表状态 | 只读 nodeId 数组」中的只读数组分支收窄出来。
 *
 * 不能直接对联合类型用内置 `Array.isArray`：其类型谓词是 `arg is any[]`，
 * 而 `readonly string[]`（ReadonlyArray）不能赋给 `any[]`，于是在三元的
 * false 分支里无法剔掉数组，`existing.entries` 会同时解析成 registry 的
 * `entries: StoredNodeEntry[]` 属性与 `Array.prototype.entries()` 方法，造成
 * `.map` 二义（TS2339 + 隐式 any TS7006，只有全包 tsc 才暴露）。
 * 守卫谓词写成 `v is readonly string[]` 即可在两分支都正确收窄，运行时仍是一次
 * `Array.isArray`，行为与内联写法完全一致；入参保留 readonly 契约，不做 as 强转。
 */
function isStringList(v: NodeRegistryState | readonly string[]): v is readonly string[] {
  return Array.isArray(v);
}

/**
 * 取首个未被占用的缺省副本 nodeId：replica-1、replica-2、replica-3…（从 1 起，不空跳号）。
 * 占用集合可传整个注册表状态，也可直接传 nodeId 字符串数组（便于表驱动单测）。
 */
export function defaultReplicaNodeId(existing: NodeRegistryState | readonly string[]): string {
  const usedIds: readonly string[] = isStringList(existing)
    ? existing
    : existing.entries.map((e) => e.nodeId);
  const used = new Set<string>(usedIds);
  for (let i = 1; i < Number.MAX_SAFE_INTEGER; i += 1) {
    const candidate = `${DEFAULT_REPLICA_PREFIX}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // 理论不可达（注册表容量远小于 SAFE_INTEGER）；兜底给出一个带时间戳的白名单内名字。
  return `${DEFAULT_REPLICA_PREFIX}${Date.now()}`;
}

/**
 * 执行「登记一个离线副本（不连接）」。同步、fail-closed；任何失败都不改变注册表。
 */
export function addReplicaFlow(
  input: AddReplicaFlowInput,
  deps: AddReplicaDeps,
): AddReplicaFlowResult {
  // 1) 远端服务器网址规范化（补协议 / host 小写 / 去尾斜杠 / 拒绝非法 host）。
  const normalized = normalizeNodeUrl(input.url);
  if (!normalized) return formFail("invalid_url");

  // 2) 显示名规范化（空白 → null，复用添加/重命名唯一口径）。
  const label = normalizeNodeLabel(input.label);

  // 3) 定副本 nodeId：显式非空白则过白名单校验（中文在此被拒），缺省取 replica-N。
  let nodeId: string;
  const explicit = input.nodeId == null ? "" : input.nodeId.trim();
  if (explicit === "") {
    nodeId = defaultReplicaNodeId(deps.store.getState());
  } else {
    nodeId = explicit;
    if (!isValidReplicaNodeId(nodeId)) return formFail("label_invalid");
  }

  // 4) 注册表查重（nodeId 被任意条目——主库/副本/远端——占用都算重名）。
  if (deps.store.getState().entries.some((e) => e.nodeId === nodeId)) {
    return formFail("duplicate");
  }

  // 5) 仅入册（不激活、不切活动指针、不连接）。网址/nodeId 已在上方按与 registry 相同的口径
  //    预检通过，故此处 throw 只可能来自并发竞态下的重名（REPLICA_PROFILE_EXISTS），统一收口 duplicate。
  let entry: StoredNodeEntry;
  try {
    entry = deps.store.addReplica({ nodeId, label, remoteBaseUrl: normalized.baseURL });
  } catch {
    return formFail("duplicate");
  }

  // registry 内部只存规范化裸 origin（剥离用户误填的子路径），回显以存储条目为准。
  return {
    kind: "added",
    nodeId: entry.nodeId,
    remoteBaseUrl: entry.replica?.remoteBaseUrl ?? normalized.origin,
    label: entry.label ?? null,
    entry,
  };
}

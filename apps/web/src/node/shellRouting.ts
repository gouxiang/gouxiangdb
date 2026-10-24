// apps/web/src/node/shellRouting.ts
// W1（IMPL-0.2.5-beta.md §2/§4）：成品 Mac 壳模式下的「同源化数据源路由」纯函数层。
//
// 核心事实（§2 铁律）：WebView 自始至终只在壳口 `http://127.0.0.1:SHELL_PORT/`，壳内反向代理
// 按「当前活动上游」（Mutex<Upstream>：None/Local/Remote/Replica）把同源请求转发到真实内核或远端。
// 因此 web 侧**任何**活动数据源（local 或 remote）都必须呈现为「壳口同源相对地址」：
//   - baseURL 恒为 ""（根部署；壳口不挂子路径），client.ts 的 withBase("","/api/..")="/api/.."；
//   - 真实 nodeId / kind / token 原样保留（token 仍由 headers() 放 X-GX-Token，代理只透传不落壳）；
//   - 协同 WS 的 host origin 回落到页面 origin（=壳口），WS 经壳口 /ws 隧道到当前上游。
//
// 远端的**真实绝对 baseURL 只保留在两处**：注册表 StoredNodeEntry.baseURL（set_active_upstream 的
// target、begin_probe 的入参）与壳内 Upstream；绝不进入 ActiveDataSource（那会让 client.ts 跨源）。
//
// 边界：本模块**纯字符串/对象运算**——不碰 window、不碰 Tauri、不读 import.meta.env、不发请求，
// node 环境可直接单测。是否处于壳模式由装配层（launcherStore）用 shellBridge.hasShell() 判定后
// 选择本模块的同源构建器还是现状 deriveActiveDataSource。

import type { ActiveDataSource, NodeKind } from "./datasource";
import { LOCAL_NODE_ID, toWsOrigin, normalizeNodeUrl } from "./resolve";
import type { StoredNodeEntry } from "./registry";
import { isPrimaryEntry } from "./registry";
import { deriveActiveDataSource } from "./launcher";

/** probe 显式目标转发的同源路径前缀（IMPL §3：/__gx/probe/<probeId>/<api 路径...>）。 */
export const PROBE_PATH_PREFIX = "/__gx/probe";

/**
 * Rust 生成的 probeId 仅允许 URL 安全字符（随机 hex/UUID 类）。
 * 显式收紧字符集，杜绝 "../"、斜杠、反斜杠等路径穿越/分段注入（fail-closed）。
 */
const PROBE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertProbeId(probeId: string): string {
  if (typeof probeId !== "string" || !PROBE_ID_RE.test(probeId)) {
    throw new Error("无效的节点探测会话标识");
  }
  return probeId;
}

/**
 * probe 会话的同源相对基址（无尾斜杠）：`/__gx/probe/<probeId>`。
 * 交给 handshake.loginRemoteNode 的 baseURL，withBase 会拼出
 * `/__gx/probe/<probeId>/api/auth/login`（见 makeProbePath），fetch 相对 URL 即落到壳口。
 */
export function makeProbeBase(probeId: string): string {
  return `${PROBE_PATH_PREFIX}/${assertProbeId(probeId)}`;
}

/**
 * 构造 probe 转发的完整同源相对路径：`/__gx/probe/<probeId>/<apiPath 去前导斜杠>`。
 * @param probeId Rust begin_probe 返回的短期随机会话 id
 * @param apiPath 业务 API 路径，如 "/api/health"（前导斜杠可有可无，统一剥掉避免双斜杠）
 */
export function makeProbePath(probeId: string, apiPath: string): string {
  const tail = apiPath.replace(/^\/+/, "");
  return `${makeProbeBase(probeId)}/${tail}`;
}

/**
 * 规范化 probe/上游目标基址：复用 resolve 层唯一口径（trim、补协议、host 小写、去尾斜杠、
 * 仅 http/https、拒非法 host）。与 normalizeNodeUrl 的区别仅在失败语义：这里**抛中文错误**
 * （begin_probe/set_upstream 入参必须已合法，遇非法是编程/数据错误，直接 fail-closed）。
 *
 * @returns 去尾斜杠的 http(s) 绝对 baseURL（origin + basePath）
 */
export function normalizeProbeBaseURL(baseURL: string): string {
  const normalized = normalizeNodeUrl(baseURL);
  if (!normalized) {
    throw new Error("节点网址不正确，需为 http:// 或 https:// 开头的有效地址");
  }
  return normalized.baseURL;
}

/**
 * 壳模式「同源化」活动数据源构建器（与 launcher.deriveActiveDataSource 同形，可整体替换注入）。
 *
 * 与现状唯一推导点的差别**仅且只能**是地址面：
 *   - local primary：现状 baseURL=本地相对前缀、wsOrigin=页面 origin+前缀；壳内 baseURL=""、wsOrigin=壳口；
 *   - local replica（离线副本，kind 仍 "local"、nodeId 为副本名）：与 primary 同走壳口根（baseURL="",
 *     wsOrigin=壳口），但**保留副本自有 nodeId**（不坍成 "local"），以便会话/401 按副本名分键分流；
 *   - remote：现状 baseURL=远端绝对 URL、wsOrigin=远端 origin；壳内 baseURL=""、wsOrigin=壳口。
 * nodeId / kind / token 三个身份字段逐字节保留（仅 primary 的 nodeId 恒为 "local"）。
 *
 * @param entry     活动节点条目（remote 的真实绝对 baseURL 在 entry 上，但不放进数据源）
 * @param token     当前会话 JWT（远端/副本为各自分键 token；主库为 gx-auth，未登录可 null）
 * @param getOrigin 页面同源 origin（生产传 window.location.origin，即壳口；测试注入）
 * @returns 无活动节点 → null（与 deriveActiveDataSource 一致）
 */
export function deriveShellActiveDataSource(
  entry: StoredNodeEntry | null,
  token: string | null,
  getOrigin: () => string,
): ActiveDataSource | null {
  if (!entry) return null;
  const kind: NodeKind = entry.kind === "local" ? "local" : "remote";
  // 主库（primary）nodeId 恒 "local"；离线副本保留自有 nodeId（≠"local"）；远端用其哈希 id。
  const nodeId =
    kind === "local"
      ? isPrimaryEntry(entry)
        ? LOCAL_NODE_ID
        : entry.nodeId
      : entry.nodeId;
  return {
    nodeId,
    kind,
    baseURL: "", // 壳口根同源；primary/replica/remote 一切业务请求都经壳代理按当前上游转发
    token,
    // 与 resolver.wsHostOrigin()（wsHostOriginFor("", origin)）同口径：纯壳口 host，不含 basePath。
    wsOrigin: toWsOrigin(getOrigin()),
  };
}

/**
 * 非壳（浏览器 / fnOS / 服务器）回落：**直接复用现状唯一推导点，不做任何改写**。
 *
* 显式包一层而非在装配处 import，是为了让单测能把「壳同源化结果」与「现网结果」并排对拍：
 * 两者差异只能出现在 baseURL / wsOrigin，nodeId / kind / token 必须全等——以此锁死「非壳零变化」。
 */
export function browserActiveDataSource(
  entry: StoredNodeEntry | null,
  token: string | null,
  getLocalBase: () => string,
  getOrigin: () => string,
): ActiveDataSource | null {
  return deriveActiveDataSource(entry, token, getLocalBase, getOrigin);
}

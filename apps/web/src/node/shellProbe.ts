// apps/web/src/node/shellProbe.ts
// W1（IMPL-0.2.5-beta.md §3/§4 line 150）：成品 Mac 壳模式下，对「尚未成为活动上游」的远端做
// 握手 / 登录时，不能走当前活动数据源（壳内 Mutex<Upstream> 可能是 None 或另一个节点），必须经
// 壳的 **probe 短期显式目标转发**：begin_probe 注册 probeId→真实 baseURL（不改当前上游），随后
// 业务请求发到同源相对路径 /__gx/probe/<probeId>/<api>，由壳盲转发到真实远端；结束立即 end_probe。
//
// 本模块是**装配层**（唯一被允许同时 import 壳桥 shellBridge 与纯逻辑 handshake/shellRouting 的地方）：
//   - 纯逻辑层（handshake / addRemoteFlow / shellRouting）不 import 本模块、不感知壳；
//   - 浏览器 / fnOS 永不触达（上层先 hasShell() 门控，probe 函数只在壳内被引用）；
//   - 一次握手或一次登录各开一个短 probe 会话（TTL≤120s，单次握手/登录秒级完成，绝不跨用户操作长持）。

import { beginProbe, endProbe } from "./shellBridge";
import { makeProbeBase, normalizeProbeBaseURL } from "./shellRouting";
import {
  handshakeNode,
  loginRemoteNode,
  type NodeHandshake,
} from "./handshake";
import type { RemoteCredentials, RemoteLoginFn } from "./launcher";
import type { StoredNodeEntry } from "./registry";

/**
 * 在一个 probe 会话内执行对某远端的单次只读/登录动作。
 *
 * 流程：规范化目标基址（fail-closed）→ begin_probe 拿 probeId → 以同源相对 probe 基址执行业务
 * 函数 → finally 立即 end_probe（注销失败不掩盖业务结果，但也不留未处理 rejection）。
 *
 * @param baseURL 用户填写/注册表保存的真实远端绝对基址（http/https）
 * @param run     收到 probe 同源相对基址（"/__gx/probe/<id>"）后执行握手或登录；内部用全局 fetch，
 *                相对 URL 在 WKWebView 天然解析到壳口 http://127.0.0.1:SHELL_PORT，零跨源。
 */
export async function withProbeSession<T>(
  baseURL: string,
  run: (probeBase: string) => Promise<T>,
): Promise<T> {
  const target = normalizeProbeBaseURL(baseURL);
  const { probeId } = await beginProbe(target);
  try {
    // makeProbeBase 内部 assertProbeId 再校验一次字符集（Rust 返回值也 fail-closed，防路径穿越）。
    return await run(makeProbeBase(probeId));
  } finally {
    // 立即注销（Rust 端幂等）；清理失败不应掩盖握手/登录的成功或失败分类。
    await endProbe(probeId).catch(() => undefined);
  }
}

/**
 * 壳模式「添加远端节点」三探针握手工厂：返回可注入 addAndRouteRemote（现行纯选路表单）或旧
 * addAndConnectRemote 的 performHandshake。与浏览器直连版唯一差别：目标地址包一层 probe 同源
 * 转发；探活/版本/初始化判定仍全在 handshakeNode。纯选路只握手不登录，本工厂不含任何凭据请求。
 */
export function probePerformHandshake(
  minNodeVersion?: string,
): (baseURL: string) => Promise<NodeHandshake> {
  return (baseURL: string) =>
    withProbeSession(baseURL, (probeBase) =>
      handshakeNode({ baseURL: probeBase, minNodeVersion }),
    );
}

/**
 * 壳模式远端登录适配器（LauncherDeps.loginRemote）：连接/重连/添加节点的登录换 JWT 都经 probe，
 * 与浏览器版 browserDefaultDeps.loginRemote 同形（缺凭据抛同一中文错），仅地址面改为 probe 同源。
 * 拿到的远端 JWT 仍由控制器写入远端会话、随后经 X-GX-Token 走壳代理透传（令牌不落壳）。
 */
export const probeLoginRemote: RemoteLoginFn = async (
  entry: StoredNodeEntry,
  creds?: RemoteCredentials,
) => {
  if (!creds) throw new Error("连接该远端节点需要账号密码");
  return withProbeSession(entry.baseURL, (probeBase) =>
    loginRemoteNode({
      baseURL: probeBase,
      email: creds.email,
      password: creds.password,
    }),
  );
};

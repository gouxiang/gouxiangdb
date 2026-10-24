// apps/web/src/node/activeAuth.ts
// 登录 / 改密结果按「当前活动数据源」分槽写入（2026-10「连接＝只选路」改造）。
//
// 连接只选路后，用户在 remote/replica-empty 态看到的是**该侧车自己的登录页**；该页提交走的还是
// api/client 的 Auth.login/signup/me（请求经壳代理转发到活动上游），但成功后的 token/user 绝不能
// 写进本地 gx-auth——那是本机主库的真相源。正确出口：
//   - 活动源是非主库独立账号源（门控开；远端或离线副本）→ 写入该节点的会话分键
//     （store.commitRemoteSession），控制器随即把活动数据源从 token=null 重推为带 JWT，守卫放行；
//   - 活动源是本机主库（含门控关闭的浏览器/fnOS/服务器）→ 不处理，返回 false 由调用方写 gx-auth，
//     与现网逐字节一致。
//
// 本模块是无 React 的薄出口，失败 fail-closed（返回 false / 不吞错），不引新依赖。

import type { UserDTO } from "@gx/shared-types";
import { dataSourceResolver } from "./datasource";
import { launcherEnabled } from "./desktopGate";
import { isLocalNodeId } from "./session";
import { getLauncherStore } from "./launcherStore";

/**
 * 当前是否处于「门控开 + 活动源是非主库独立账号源（远端节点或离线副本）」。
 * 账号归属按 nodeId 二分（不再只看 kind——副本 kind 也是 "local"）：nodeId!=="local" 即独立侧车。
 * 登录/改密出口据此决定写该节点分键还是本地 gx-auth。不检查 token：empty（token=null）同样为
 * true——那正是要在侧车登录页提交后落分键的态。
 */
export function isActiveIsolatedSource(): boolean {
  return launcherEnabled() && !isLocalNodeId(dataSourceResolver.current().nodeId);
}

/**
 * 把登录/注册成功拿到的 {token,user} 写入**当前活动源**对应的会话槽。
 * @returns true=已写入该节点会话分键（调用方不要再 setAuth 本地）；false=活动源是本机主库/门控关，
 *          调用方应走原有 setAuth(token,user) 写 gx-auth。
 * 远端/副本提交路径上若仓库不可用（理论不该发生）会抛错，由登录页 catch，绝不静默写本地槽。
 */
export function commitLoginForActiveSource(token: string, user: UserDTO): boolean {
  if (!isActiveIsolatedSource()) return false;
  const ds = dataSourceResolver.current();
  getLauncherStore().commitRemoteSession(ds.nodeId, token, user);
  return true;
}

/**
 * 改密成功但 me() 拉取失败时的本地兜底：把活动侧车会话 user 的给定字段（mustChangePassword=false）
 * 就地补丁。@returns true=已补丁侧车会话；false=本机主库（调用方走 updateUser 写 gx-auth）。
 */
export function patchActiveRemoteUser(patch: Partial<UserDTO>): boolean {
  if (!isActiveIsolatedSource()) return false;
  const ds = dataSourceResolver.current();
  getLauncherStore().patchRemoteSessionUser(ds.nodeId, patch);
  return true;
}

/**
 * 退出当前活动会话（个人中心「退出登录」出口）。
 *   - 非主库活动源（远端或离线副本）→ 清该节点会话分键但**保持选路态**
 *     （store.deauthenticateRemote：activeNodeId 不变、壳上游不动、重推 token=null 数据源），
 *     返回 true（调用方不要再 logout 本地 gx-auth）；
 *   - 本机主库/门控关 → 返回 false，调用方走原 logout() 清 gx-auth + 跳登录页。
 * 与 401 桥（installLauncher → deauthenticateRemote）同动作；此处供用户主动退出复用。
 * 动作为异步但无需调用方等待结果（守卫下一拍即见 authenticated=false），故 fire-and-forget。
 */
export function deauthenticateActiveSource(): boolean {
  if (!isActiveIsolatedSource()) return false;
  const ds = dataSourceResolver.current();
  void getLauncherStore()
    .deauthenticateRemote(ds.nodeId)
    .catch(() => undefined);
  return true;
}

/**
 * 改密成功且 me() 拿到最新 user 后，用**当前活动数据源的 token** + 最新 user 重写活动会话。
 * 远端/副本：重写该节点会话分键（改密可能换发 JWT，也可能沿用——以随后的请求/401 桥为准）；
 * 本机主库：返回 false，调用方用 gx-auth 当前 token + 新 user 走 setAuth（现状）。
 */
export function refreshActiveSourceUser(user: UserDTO): { handled: boolean; token: string | null } {
  if (!isActiveIsolatedSource()) {
    return { handled: false, token: dataSourceResolver.current().token };
  }
  const ds = dataSourceResolver.current();
  if (!ds.token) {
    // 理论不可达：能改密说明请求带了有效 token。fail-closed：不写空会话，交调用方按错误处理。
    throw new Error("侧车改密成功但活动数据源缺少 token");
  }
  getLauncherStore().commitRemoteSession(ds.nodeId, ds.token, user);
  return { handled: true, token: ds.token };
}

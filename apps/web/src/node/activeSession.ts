// apps/web/src/node/activeSession.ts
// 「当前活动会话」统一读取层（2026-10「连接＝只选路」改造）。
//
// 之前守卫只能读本地 gx-auth 或一个布尔的 useRemoteSessionActive()，无法回答：
//   此刻活动源是 local 还是 remote？nodeId？token？活动远端会话里的 user（mustChangePassword）？
// 本模块给出唯一的活动会话视图 { enabled, kind, nodeId, token, user, authenticated }，供：
//   - App.tsx 路由守卫（RequireAuth / RequirePasswordChanged / /login 分流）；
//   - NodeLauncherGate「进入工作区」分流（本地空库引导 / 远端自己的登录页 / 直接进）。
//
// 引用稳定（关键）：resolver 对 local 槽每次 current() 都新建对象、远端会话 user 每次读取也是
// 新对象，直接当 useSyncExternalStore 快照会被判「每帧都变」而无限重渲。故模块级缓存上一次结果，
// 仅当签名 (enabled,kind,nodeId,token,user.id,mustChangePassword,updatedAt) 变化才返回新引用。
//
// 门控关闭（浏览器/fnOS/服务器）时：kind 恒 local、token/user 即 gx-auth，与现网逐字节等价；
// getLauncherStore() 只在「门控开且活动源确为远端」分支里才被调用，门控关永不构造启动器仓库。

import { useSyncExternalStore } from "react";
import type { UserDTO } from "@gx/shared-types";
import { dataSourceResolver, type ActiveDataSource, type NodeKind } from "./datasource";
import { launcherEnabled } from "./desktopGate";
import { LOCAL_NODE_ID } from "./resolve";
import { isLocalNodeId } from "./session";
import { useAuthStore } from "../store/auth";
import type { RemoteSessionView } from "./remoteSessions";
import { getLauncherStore } from "./launcherStore";

/** 活动会话视图：守卫/分流需要的全部字段的只读快照。 */
export interface ActiveSessionView {
  /** 桌面启动器门控是否开启（门控关时下面是纯 local/gx-auth 视图）。 */
  enabled: boolean;
  /**
   * 传输/地址语义（看数据源 kind）：离线副本仍是 "local"（经壳口同源代理），不能改成 "remote"，
   * 否则地址面会被误判。账号归属分流请看 nodeId / primary，而非 kind。
   */
  kind: NodeKind;
  /** 主库恒 "local"；远端为哈希 id；离线副本为副本白名单名。 */
  nodeId: string;
  /**
   * 是否为唯一本机主库（nodeId==="local"，读写 gx-auth）。true=主库；false=非主库独立账号源
   * （远端或离线副本，会话 JWT/user 走该 nodeId 的分键）。门控关恒为 true（现网零变化铁律）。
   * 守卫据此区分"未登录回 /login（侧车自己的登录页）还是回 /launcher"。
   */
  primary: boolean;
  /** 活动槽 JWT；未登录（含 remote/replica-empty）为 null。 */
  token: string | null;
  /** 活动会话用户：主库取 gx-auth.user，非主库取该 nodeId 会话分键里的 user；未登录为 null。 */
  user: UserDTO | null;
  /** 活动槽是否已带 token（守卫放行条件）。empty 态为 false。 */
  authenticated: boolean;
}

export interface DeriveActiveSessionArgs {
  enabled: boolean;
  ds: ActiveDataSource;
  /** 本机主库用户（gx-auth.user）。 */
  localUser: UserDTO | null;
  /** 活动非主库源（远端/副本）的已存会话（无/主库时 null）。 */
  remoteSession: RemoteSessionView | null;
}

/**
 * 纯选择器（可单测）：由门控 + 当前数据源 + 两边会话真相源拼出活动会话视图。
 * 账号归属按 nodeId 二分（不再只看 kind）：
 *   - 门控关：忽略 ds 的任何形态，强制按主库/gx-auth 读（现网绝不会有侧车 ds），primary:true；
 *   - 门控开 + nodeId==="local"（主库）：主库视图，token/user 取 gx-auth；
 *   - 门控开 + 非主库 nodeId（远端哈希 id 或副本名）：isolated 视图，primary:false，kind 保留
 *     ds.kind（副本仍 "local"），user 取该 nodeId 分键会话。
 */
export function deriveActiveSession(args: DeriveActiveSessionArgs): ActiveSessionView {
  if (!args.enabled || isLocalNodeId(args.ds.nodeId)) {
    // 门控关（浏览器/fnOS/服务器）强制按主库/gx-auth 读：非主库 ds 现网不可能出现，
    // 其 token 不取（置 null）。主库认证只看主库槽 token，与门控开关**无关**——
    // 否则门控关时本地登录后 authenticated 恒 false，会破坏现网登录放行（零变化铁律）。
    const isPrimaryDs = args.ds.nodeId === LOCAL_NODE_ID;
    const localToken = isPrimaryDs ? args.ds.token : null;
    return {
      enabled: args.enabled,
      kind: "local",
      nodeId: LOCAL_NODE_ID,
      primary: true,
      token: localToken,
      user: args.localUser,
      authenticated: Boolean(isPrimaryDs && args.ds.token),
    };
  }
  // 门控开 + 非主库独立账号源（远端或离线副本）：身份取 ds，user 取该 nodeId 分键。
  const user = args.remoteSession?.user ?? null;
  return {
    enabled: true,
    kind: args.ds.kind, // 传输语义：副本仍 "local"，远端 "remote"
    nodeId: args.ds.nodeId,
    primary: false,
    token: args.ds.token,
    user,
    authenticated: Boolean(args.ds.token),
  };
}

/**
 * 读活动非主库源（远端/副本）的分键会话；任何环境不可用（SSR 无 localStorage 等）→ null，绝不抛错。
 * 主库（nodeId==="local"）不读分键（其真相源是 gx-auth）；门控关也不读。
 * getLauncherStore() 懒构造浏览器单例，仅门控开 + 非主库活动源分支触达；门控关/主库零副作用。
 */
function readActiveRemoteSession(enabled: boolean, ds: ActiveDataSource): RemoteSessionView | null {
  if (!enabled || isLocalNodeId(ds.nodeId) || !ds.nodeId) return null;
  if (typeof window === "undefined") return null;
  try {
    return getLauncherStore().getRemoteSession(ds.nodeId);
  } catch {
    return null;
  }
}

function computeView(): ActiveSessionView {
  const enabled = launcherEnabled();
  const ds = dataSourceResolver.current();
  const localUser = useAuthStore.getState().user;
  const remoteSession = readActiveRemoteSession(enabled, ds);
  return deriveActiveSession({ enabled, ds, localUser, remoteSession });
}

/** 决定快照身份的签名：只含会影响守卫/分流取值的字段。 */
function signatureOf(v: ActiveSessionView): string {
  return [
    v.enabled ? 1 : 0,
    v.primary ? 1 : 0,
    v.kind,
    v.nodeId,
    v.token ?? "",
    v.user?.id ?? "",
    v.user?.mustChangePassword === true ? 1 : 0,
    v.user?.updatedAt ?? "",
  ].join("|");
}

let cached: { sig: string; view: ActiveSessionView } | null = null;

function getSnapshot(): ActiveSessionView {
  const view = computeView();
  const sig = signatureOf(view);
  if (!cached || cached.sig !== sig) {
    cached = { sig, view };
  }
  return cached.view;
}

function getServerSnapshot(): ActiveSessionView {
  // SSR/首拍：非浏览器无活动非主库源，给门控关主库空会话（门控在桌面构建为构建期常量）。
  const enabled = launcherEnabled();
  return {
    enabled,
    kind: "local",
    nodeId: LOCAL_NODE_ID,
    primary: true,
    token: null,
    user: null,
    authenticated: false,
  };
}

/**
 * 订阅会改变活动会话视图的来源：
 *   - resolver 切换/重推（选路、commit token、deauth）；
 *   - 本地 gx-auth（门控关登录态、本地 user 变化；resolver local 不主动 emit）；
 *   - 启动器仓库（远端会话写入/清除/user patch 等不触发 resolver emit 的动作）。
 * 仓库订阅同样包在 try/catch：单例环境不可用时 read 侧已 fail-closed。
 */
function subscribe(onChange: () => void): () => void {
  const unsubs: Array<() => void> = [
    dataSourceResolver.subscribe(onChange),
    useAuthStore.subscribe(onChange),
  ];
  if (launcherEnabled() && typeof window !== "undefined") {
    try {
      unsubs.push(getLauncherStore().subscribe(onChange));
    } catch {
      // 无 localStorage/单例不可用：忽略，read 侧返回 remote 无 user 视图。
    }
  }
  return () => unsubs.forEach((u) => u());
}

/**
 * 订阅当前活动会话（引用稳定）。门控关返回的 local/token/user 与直接读 gx-auth 等价。
 */
export function useActiveSession(): ActiveSessionView {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 仅供测试：复位模块级快照缓存。 */
export function __resetActiveSessionForTest(): void {
  cached = null;
}

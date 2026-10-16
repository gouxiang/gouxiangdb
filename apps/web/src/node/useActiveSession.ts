// apps/web/src/node/useActiveSession.ts
// 供路由守卫判断「当前是否存在一个可用会话」——本地 gx-auth 或远端活动槽（DESIGN §8.5 单活）。
//
// 为什么快照是字符串标量而不是 current() 对象：resolver 对 local 槽每次 current() 都新建对象
// （实时读最新 base/token），直接当 useSyncExternalStore 快照会被判为"每帧都变"而无限重渲。
// 守卫只需要知道"是否远端槽且有 token"，故快照压缩成稳定字符串：
//   门控关 / local 槽 → "local"（是否放行仍只看本地 gx-auth，与现网逐字节一致）；
//   远端槽有 token   → "remote"；远端槽无 token → "remote-empty"。
//
// 浏览器/fnOS 下门控关闭，本 hook 恒返回 "local"，绝不因启动器逻辑改变现有守卫。

import { useSyncExternalStore } from "react";
import { dataSourceResolver } from "./datasource";
import { launcherEnabled } from "./desktopGate";

const SNAPSHOT_LOCAL = "local";
const SNAPSHOT_REMOTE = "remote";
const SNAPSHOT_REMOTE_EMPTY = "remote-empty";

/**
 * 纯判定（可单测）：由门控 + 当前数据源 kind/token 推导快照分类。
 * 门控关一律 local（现网零变化，绝不读远端语义）。
 */
export function activeSessionSnapshot(input: {
  enabled: boolean;
  kind: "local" | "remote";
  token: string | null;
}): string {
  if (!input.enabled || input.kind !== "remote") return SNAPSHOT_LOCAL;
  return input.token ? SNAPSHOT_REMOTE : SNAPSHOT_REMOTE_EMPTY;
}

function computeSnapshot(): string {
  const ds = dataSourceResolver.current();
  return activeSessionSnapshot({
    enabled: launcherEnabled(),
    kind: ds.kind,
    token: ds.token,
  });
}

/**
 * 当前活动会话是否为「已登录的远端节点」。门控关或本地槽恒为 false。
 * 供 RequireAuth 在桌面纯远端场景放行（API 请求由 apiFetch 自动带远端 JWT）。
 */
export function useRemoteSessionActive(): boolean {
  const snap = useSyncExternalStore(
    dataSourceResolver.subscribe,
    computeSnapshot,
    () => SNAPSHOT_LOCAL,
  );
  return snap === SNAPSHOT_REMOTE;
}

/** 仅供测试：直接取当前快照分类。 */
export const __activeSessionSnapshot = computeSnapshot;

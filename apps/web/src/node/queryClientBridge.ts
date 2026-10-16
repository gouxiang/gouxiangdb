// apps/web/src/node/queryClientBridge.ts
// 节点模式 S2：数据源切换时清空 react-query 缓存的桥接（DESIGN §8.5 单活会话）。
//
// 为什么需要：react-query 按 queryKey 缓存响应，切换节点（local↔远端 A↔远端 B）后，
// 若不清缓存，界面会短暂渲染上一个节点的库表/记录，且后台 refetch 的 in-flight 响应可能
// 回填到错误节点的视图。方案 A（戴总/调研拍板，最简且对 local 零回归）：节点一切换就
// 对所有已注册 QueryClient 调 clear()，让界面随新源重新拉取，不逐个按 queryKey 前缀清理。
//
// 设计约束：
//   - node 域保持纯逻辑，**不 import @tanstack/react-query**：用结构化最小接口 Clearable
//     （只要 clear()），生产传入真实 QueryClient，单测传 fake；
//   - 只在 nodeId 真正变化时清；同节点重复 setActive（如 local token 刷新、测试复位）不清，
//     避免无谓抖动；
//   - 默认订阅 dataSourceResolver 单例，但 bind 可注入 resolver，便于纯逻辑测试。

import { dataSourceResolver, type DataSourceResolver } from "./datasource";

/** 仅依赖 clear() 的结构化类型，避免 node 域依赖 react-query。 */
export interface Clearable {
  clear(options?: { notify?: boolean }): void;
}

const clients = new Set<Clearable>();
let boundResolver: DataSourceResolver | null = null;
let lastNodeId: string | null = null;

/** 注册一个要在切节点时清空的 QueryClient（主 client + embed 独立 root client）。幂等。 */
export function registerQueryClient(client: Clearable): void {
  clients.add(client);
}

/** 测试用：清空注册表与绑定状态（每个用例后复位）。 */
export function __resetQueryClientBridgeForTest(): void {
  clients.clear();
  boundResolver = null;
  lastNodeId = null;
}

/**
 * 订阅数据源解析器：nodeId 变化时清空所有已注册 client。
 * 幂等——同一 resolver 重复绑定只生效一次（生产 main.tsx 调用，StrictMode 双调用安全）；
 * 测试可注入独立 resolver 实例各绑各的。
 * @returns 取消订阅（主要供测试用）。
 */
export function bindQueryClientClearing(
  resolver: DataSourceResolver = dataSourceResolver,
): () => void {
  if (boundResolver === resolver) return () => {};
  boundResolver = resolver;
  lastNodeId = resolver.current().nodeId;
  const unsubscribe = resolver.subscribe(() => {
    const nextNodeId = resolver.current().nodeId;
    if (nextNodeId === lastNodeId) return; // 同节点刷新（如 token 变化）不清
    lastNodeId = nextNodeId;
    clients.forEach((c) => c.clear());
  });
  return unsubscribe;
}

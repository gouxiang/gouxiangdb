// apps/web/src/node/datasource.ts
// 节点模式 S1（DESIGN §6.1）：数据源解析器骨架。
//
// S1 阶段 `current()` **恒返回 local 数据源**，且 local 的 baseURL / headers / baseFor /
// wsOrigin 必须与今天的既有实现（api/client.ts + features/collab）逐字节同口径，
// 保证本地模式零回归。remote 槽本阶段不接线、不被任何业务调用，仅在内部预留 active
// 切换位与 subscribe 通知（供后续 S2+ 使用，仅测试触达）。

import { resolveApiBase, withBase } from "../lib/base";
import { authHeaders } from "../api/authHeader";
import { useAuthStore } from "../store/auth";
import { LOCAL_NODE_ID, localWsOrigin } from "./resolve";

/** 数据源所属节点类型（DESIGN §6.1）：本机节点 / 远端节点。 */
export type NodeKind = "local" | "remote";

/** 当前生效的数据源描述（DESIGN §6.1 ActiveDataSource）。 */
export interface ActiveDataSource {
  /** "local" 或远端节点稳定 id（规范化 URL 哈希得到）。 */
  nodeId: string;
  kind: NodeKind;
  /** local：同源相对前缀（"" 或 "/app/gouxiangdb"）；remote：去尾斜杠绝对 URL。 */
  baseURL: string;
  /** 当前会话对应槽位的 JWT；未登录为 null。 */
  token: string | null;
  /** 由 baseURL 派生的 WS 根：http→ws、https→wss（复用 collab 同口径换算）。 */
  wsOrigin: string;
}

export interface DataSourceResolver {
  /** 同步读取当前数据源（会话信息就位后须纯同步，避免给上千调用点加 async）。 */
  current(): ActiveDataSource;
  /** = withBase(current().baseURL, path)。 */
  baseFor(path: string): string;
  /** = authHeaders(current().token)，与今天 client.ts 发出的头完全一致。 */
  headers(): Record<string, string>;
  /** 订阅数据源切换；返回取消订阅函数。 */
  subscribe(fn: () => void): () => void;
}

/** 工厂依赖（均可注入，便于纯 node 单测；生产单例用默认实现）。 */
export interface ResolverDeps {
  /** 本地相对 API 前缀；默认复用现有 resolveApiBase(VITE_API_URL, BASE_URL)，取值逐字节一致。 */
  getLocalBase?: () => string;
  /** 页面同源 origin；默认 window.location.origin，node/非浏览器回落与 collab 一致。 */
  getOrigin?: () => string;
  /** 本地会话 token；默认从既有 auth store 读取（不新增第二真相源）。 */
  getLocalToken?: () => string | null;
}

/** 非浏览器环境兜底 origin，与 collab defaultOrigin 完全一致。 */
function defaultOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "http://localhost";
}

/** 默认本地 API 前缀：与 api/client.ts:97-100 同一表达式、同一取值。 */
function defaultGetLocalBase(): string {
  return resolveApiBase(
    (import.meta.env.VITE_API_URL as string | undefined) ?? undefined,
    import.meta.env.BASE_URL as string | undefined,
  );
}

/**
 * 创建数据源解析器。S1：内部 active 恒为 local，且 current() 每次实时读 base/token，
 * 因此即便后续在 S2+ 接线前，local 的 baseURL/token 也永远反映最新部署前缀与登录态。
 */
export function createDataSourceResolver(initial?: ResolverDeps): DataSourceResolver & {
  /**
   * 仅测试用：切换当前 active 数据源并通知订阅者。
   * 生产代码不得调用（S1 无任何业务入口触达），命名显式带 __test 以隔离误用。
   */
  __setActiveForTest(next: ActiveDataSource): void;
} {
  const getLocalBase = initial?.getLocalBase ?? defaultGetLocalBase;
  const getOrigin = initial?.getOrigin ?? defaultOrigin;
  const getLocalToken =
    initial?.getLocalToken ?? (() => useAuthStore.getState().token ?? null);

  const listeners = new Set<() => void>();

  function buildLocal(): ActiveDataSource {
    const baseURL = getLocalBase();
    return {
      nodeId: LOCAL_NODE_ID,
      kind: "local",
      baseURL,
      token: getLocalToken(),
      wsOrigin: localWsOrigin(baseURL, getOrigin()),
    };
  }

  // S1：当前 active 构建器恒为 local。S2+ 会在此引入 remote 槽；切换走 __setActiveForTest
  // 之外的正式出口（connect.ts），本阶段刻意不导出任何设置 remote 的生产 API。
  let buildActive: () => ActiveDataSource = buildLocal;

  return {
    current() {
      return buildActive();
    },
    baseFor(path: string) {
      return withBase(buildActive().baseURL, path);
    },
    headers() {
      return authHeaders(buildActive().token);
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    __setActiveForTest(next: ActiveDataSource) {
      buildActive = () => next;
      listeners.forEach((fn) => fn());
    },
  };
}

/**
 * 进程级单例。S1 阶段**没有任何既有文件 import 它**（零接线、tree-shake 友好）；
 * S2 起 client.ts 才会改读此单例。
 */
export const dataSourceResolver = createDataSourceResolver();

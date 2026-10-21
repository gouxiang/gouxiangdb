// /api/local-sync/conflicts：桌面离线副本拓扑下的【同步中心冲突/隔离代理】（beta.2 B2）。
// 设计权威：docs/design/2026-10-node-mode/BLUEPRINT-beta2-offline.md §52/§54「复用现有
// incoming/resolve、无需新服务端点」在副本拓扑下的落地形态。
//
// 背景：Tauri 壳内浏览器同源只打【本地侧车 API】；侧车内核以 GX_SYNC_SERVER=off 运行，
//   /api/v1/sync/* 服务端面在本地整组 404。而冲突列表（listIncoming，含字段掩码后的
//   conflictServerPayload）、retry/discard、resolveConflict（mine/theirs/custom 五裁决）
//   的唯一权威实现在【远端服务器】，remoteToken 也只存在于同步引擎配置里、浏览器握不到。
//   故由侧车用 replicaSyncConfig() 的 remoteUrl+remoteToken 把同步中心四个操作【纯转发】
//   到远端 /api/v1/sync，原样透传结果——绝不在客户端重建裁决引擎、不访问本地任何表。
//
// 挂载纪律（与 routes/localSync.ts 同款「恒挂载 + 请求期闸门」）：
//   - 组首中间件每次请求现场解析 replicaSyncConfig()：GX_OFFLINE_REPLICA 未开 或
//     GX_REPLICA_REMOTE_URL trim 空（出厂默认）-> 在任何转发/鉴权之前直接 404 SYNC_DISABLED；
//   - 随后 requireActiveUser（X-GX-Token / Authorization 均收，针对的是浏览器→侧车这一跳）。
//
// 对上游的身份：一律使用引擎配置里的 remoteToken（X-GX-Token），【绝不】透传浏览器给侧车
//   的 Authorization/Cookie/Origin/Referer——对外请求头由本文件白名单重建。
//
// 可注入性：createLocalSyncProxyRoutes({ fetchImpl?, config? }) 仅供 headless 单测传假 fetch/
//   假 config；生产默认导出 localSyncProxyRoutes 零参数即可直接 .route 挂载，零新增依赖。

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { replicaSyncConfig, type ReplicaSyncConfig } from "../configReplica.js";
import { HttpError } from "../httpError.js";
import { requireActiveUser } from "../middleware/authActive.js";

/** 上游 fetch 形状（Node22 全局 fetch）。 */
export type LocalSyncProxyFetch = typeof fetch;

/** 工厂依赖：均可缺省（生产走 globalThis.fetch + replicaSyncConfig + requireActiveUser）。 */
export interface LocalSyncProxyDeps {
  /** 上游 HTTP 传输（测试注入假实现，不起真实网络）。 */
  fetchImpl?: LocalSyncProxyFetch;
  /** 引擎配置读取（测试注入固定 config/null；生产每次请求现场读 env，不做模块级缓存）。 */
  config?: () => ReplicaSyncConfig | null;
  /**
   * 鉴权中间件（仅 headless 单测可注入直通桩以避开登录/DB）；
   * 生产缺省恒为 requireActiveUser，与 routes/localSync.ts 同一道闸。
   */
  authMiddleware?: MiddlewareHandler;
}

/** incoming 行 id 形态：cuid 风小写字母数字，20–40 位；拒绝一切穿越/杂字符（/、..、?、#）。 */
const INCOMING_ID_RE = /^[a-z0-9]{20,40}$/;

/** GET /incoming 允许透传的 query 白名单；其余键（含手写杂参）一律丢弃。 */
const INCOMING_QUERY_KEYS = ["status", "baseId", "limit"] as const;

/** /resolve 侧车本地放行的裁决值；compound/replayData 本期不暴露给副本 UI。 */
const RESOLVE_DECISIONS = new Set(["mine", "theirs", "custom"]);

/**
 * 构造冲突代理路由。
 * @param deps.fetchImpl 默认 globalThis.fetch（bind 全局，避免 undici 接收器问题）。
 * @param deps.config   默认 replicaSyncConfig（请求期读 env，运维改 env 无需重启）。
 */
export function createLocalSyncProxyRoutes(deps: LocalSyncProxyDeps = {}): Hono {
  const fetchImpl: LocalSyncProxyFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const getConfig: () => ReplicaSyncConfig | null = deps.config ?? replicaSyncConfig;
  const authMiddleware: MiddlewareHandler = deps.authMiddleware ?? requireActiveUser;

  const routes = new Hono();

  // ① 总门：配置不齐全（默认）即 404，短路在鉴权/转发之前。判定与 startReplicaSync 同源。
  routes.use("*", async (_c, next) => {
    if (!getConfig()) {
      throw new HttpError(404, "同步服务未启用", "SYNC_DISABLED");
    }
    return next();
  });

  // ② 鉴权：登录且账号 ACTIVE（浏览器 → 侧车这一跳；与 localSync.ts 完全同款）。
  routes.use("*", authMiddleware);

  // 1) GET / → 远端 GET /api/v1/sync/incoming（白名单 query：status/baseId/limit）。
  routes.get("/", async (c) => {
    const qs = new URLSearchParams();
    for (const k of INCOMING_QUERY_KEYS) {
      const v = c.req.query(k);
      if (v !== undefined && v !== "") qs.set(k, v);
    }
    const q = qs.toString();
    return forward(c, getConfig, fetchImpl, {
      method: "GET",
      path: "/incoming",
      ...(q ? { query: q } : {}),
    });
  });

  // 2) POST /:id/retry → 远端 POST /api/v1/sync/incoming/:id/retry，侧车发空 JSON 对象。
  routes.post("/:id/retry", async (c) => {
    const id = checkIncomingId(c.req.param("id"));
    return forward(c, getConfig, fetchImpl, {
      method: "POST",
      path: `/incoming/${id}/retry`,
      jsonBody: {},
    });
  });

  // 3) POST /:id/discard → 远端 POST /api/v1/sync/incoming/:id/discard，固定 {confirm:true}。
  routes.post("/:id/discard", async (c) => {
    const id = checkIncomingId(c.req.param("id"));
    return forward(c, getConfig, fetchImpl, {
      method: "POST",
      path: `/incoming/${id}/discard`,
      jsonBody: { confirm: true },
    });
  });

  // 4) POST /resolve → 远端 POST /api/v1/sync/resolve，只透传四个白名单字段。
  //    固定段 "/resolve" 与 "/:id/retry"（两段）在 Hono 中不冲突。
  routes.post("/resolve", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const decision = body?.decision;
    // decision 白名单在侧车本地裁决：compound/replayData/其它/缺失一律 400，不发上游。
    if (typeof decision !== "string" || !RESOLVE_DECISIONS.has(decision)) {
      throw new HttpError(400, "decision 必须是 mine/theirs/custom", "SYNC_RESOLVE_BAD_DECISION");
    }
    // 只取白名单字段；compound/replayData 及任何杂键在此被剥离，绝不转发。
    const upstreamBody: Record<string, unknown> = {
      resolveOf: typeof body?.resolveOf === "string" ? body.resolveOf : "",
      decision,
    };
    const clientOpId = body?.clientOpId;
    if (typeof clientOpId === "string" && clientOpId.trim() !== "") {
      upstreamBody.clientOpId = clientOpId.trim();
    }
    const patch = body?.patch;
    if (patch !== undefined && patch !== null) upstreamBody.patch = patch;

    return forward(c, getConfig, fetchImpl, {
      method: "POST",
      path: "/resolve",
      jsonBody: upstreamBody,
    });
  });

  return routes;
}

/** 生产默认路由：零参数、零模块级配置缓存，可直接 mount.route(prefix, localSyncProxyRoutes)。 */
export const localSyncProxyRoutes = createLocalSyncProxyRoutes();

/** 校验 incoming 行 id：非空、cuid 风白名单、不含 / 与 .. 等穿越片段；不合法 400 SYNC_BAD_REQUEST。 */
function checkIncomingId(raw: string | undefined): string {
  const id = typeof raw === "string" ? raw : "";
  if (!id || id.includes("/") || id.includes("..") || id.includes("?") || id.includes("#") || !INCOMING_ID_RE.test(id)) {
    throw new HttpError(400, "非法的同步项 id", "SYNC_BAD_REQUEST");
  }
  return id;
}

/** forward() 参数：path 为相对 /api/v1/sync 的已校验路径（id 已 encodeURIComponent 等价处理）。 */
interface ForwardOptions {
  method: "GET" | "POST";
  path: string;
  /** 已编码的 query string（不含前导 ?）。 */
  query?: string;
  /** JSON 请求体；缺省则不带 body。 */
  jsonBody?: unknown;
}

/**
 * 纯转发核心：现场取 config，用 remoteToken 调远端，按状态码分类透传/兜底。
 * 本函数不访问 prisma、不读写任何表、不触发同步引擎。
 */
async function forward(
  c: Context,
  getConfig: () => ReplicaSyncConfig | null,
  fetchImpl: LocalSyncProxyFetch,
  opts: ForwardOptions,
): Promise<Response> {
  // 处理期再次现场取 config（与组首门同源；不缓存模块级快照）。
  const cfg = getConfig();
  if (!cfg) throw new HttpError(404, "同步服务未启用", "SYNC_DISABLED");

  const base = cfg.remoteUrl.replace(/\/+$/, "");
  let url = `${base}/api/v1/sync${opts.path}`;
  if (opts.query) url += `?${opts.query}`;

  // 对外请求头白名单重建：只带引擎令牌与 JSON content-type，
  // 浏览器给侧车的 Authorization/Cookie/Origin/Referer 等一律不随行。
  const headers: Record<string, string> = {
    "X-GX-Token": cfg.remoteToken,
    "content-type": "application/json",
  };

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: opts.method,
      headers,
      ...(opts.jsonBody !== undefined ? { body: JSON.stringify(opts.jsonBody) } : {}),
    });
  } catch {
    // DNS/拒绝连接/重置/超时等传输层失败：502，与"功能未启用 404"严格区分。
    throw new HttpError(502, "无法连接远端服务器", "SYNC_UPSTREAM_UNREACHABLE");
  }

  const raw = await upstream.text();
  let hasJson = false;
  if (raw) {
    try {
      JSON.parse(raw);
      hasJson = true;
    } catch {
      hasJson = false;
    }
  }

  if (upstream.ok) {
    // 2xx：远端 {result:{...}} 信封原样透传，侧车恒回 200；2xx 却非 JSON 视为网关故障。
    // 用原生 Response 直透原始文本（不经 c.json 泛型重写），与下方 4xx/5xx 透传分支同一手法，
    // 也避免 Hono 对 unknown JSON 做过深类型实例化（TS2589）。
    if (hasJson) {
      return new Response(raw, {
        status: upstream.status,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }
    throw new HttpError(502, "无法连接远端服务器", "SYNC_UPSTREAM_UNREACHABLE");
  }

  if (upstream.status >= 400 && upstream.status < 500) {
    // 4xx：保真状态码（409 SYNC_RESOLVE_NOT_CONFLICT、远端 404 等必须直达前端弹窗，
    // 绝不能被误判成本地 SYNC_DISABLED）；有 JSON 体原样透传。
    if (hasJson) {
      return new Response(raw, {
        status: upstream.status,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }
    // 4xx 但无合法 JSON 体：回同状态码 + 兜底 {error,code} 信封。
    return c.json(
      { error: `远端请求失败（HTTP ${upstream.status}）`, code: "SYNC_UPSTREAM_ERROR" },
      upstream.status as ContentfulStatusCode,
    );
  }

  // 5xx：有 JSON 体时透传状态码与体；无 JSON（HTML 错页/空响应）归一为 502 不可达。
  if (hasJson) {
    return new Response(raw, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  }
  throw new HttpError(502, "无法连接远端服务器", "SYNC_UPSTREAM_UNREACHABLE");
}

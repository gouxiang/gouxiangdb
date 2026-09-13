// apps/api/scripts/bench/load.ts
// M1/S9 单场景负载执行：50 次预热丢弃 → 顺序翻页解析深页 cursor（若需要）→ 并发 ≥200 采样，
// 逐请求记录客户端往返 + 服务端三头（serve-ms/physical-sql/prisma-calls/rss）+ 超时计数。
// 纯 fetch，无第三方依赖；并发用固定 worker 池，不用 Promise.all 一次性打爆连接。
//
// 分页口径随档切换：on 档用 cursor（无 SQL OFFSET），off/shadow 档用 offset（旧 slice）。
// deep_window_edge 场景刻意把 offset 顶到 keyset 窗口外（limit×5+一页），on 必 400、
// 其余档 200——按期望状态码判成功，用于坐实"深翻窗口边缘 400"。

import type { ResolvedScene } from "./prep-scenes.js";
import { summarizeSamples, type Sample, type ScenarioStats } from "./stats.js";

export type GateMode = "off" | "shadow" | "on";

export interface RunOptions {
  baseUrl: string;
  token: string;
  tableId: string;
  /** 主字段 id（写场景创建记录时写标题用）。 */
  titleFieldId: string;
  limit: number;
  warmup: number;
  samples: number;
  concurrency: number;
  mode: GateMode;
  /** 单次请求超时毫秒（默认 30000），超时记为一个失败+超时样本。 */
  timeoutMs: number;
  /**
   * on 档深页场景的预置边界游标（run-gate 用只读连接在覆盖索引上一次性定位，避免逐 HTTP 翻
   * 上千页：每页都要当页 hydrate，10 万行翻到 80% 页要数千秒）。采样仍打真实 HTTP keyset。
   * 仅 on 档提供；off/shadow 走 offset（continuationForDeep 直接换算、不翻页）。
   */
  deepCursor?: string | null;
}

export interface ScenarioResult {
  scene: string;
  kind: string;
  mode: string; // keyset 档位（响应 degraded 或推断），写为 "write"
  desc: string;
  stats: ScenarioStats;
}

function headerNum(h: Headers, name: string): number {
  const v = h.get(name);
  if (v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 沿 cause 链提取首个传输层错误码（ECONNRESET/ECONNREFUSED/UND_ERR_SOCKET…）。
 * Node 全局 fetch（undici）常把系统错误包在 error.cause 里，故不能只看顶层 code。
 */
function errorCode(e: unknown): string | null {
  let cur: any = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur.code === "string" && cur.code) return cur.code;
    cur = cur.cause;
  }
  return e instanceof Error ? e.name : "UNKNOWN";
}

/** 该场景是否走 keyset cursor 翻页（仅 on 档响应带 nextCursor）。 */
function useCursor(o: RunOptions): boolean {
  return o.mode === "on";
}

/** 构造该场景一次列表请求的 URL（page 续点可为 cursor 或 offset）。 */
function listUrl(o: RunOptions, s: ResolvedScene, cont: { cursor: string | null; offset: number }): string {
  const u = new URL(`${o.baseUrl}/api/records`);
  u.searchParams.set("tableId", o.tableId);
  u.searchParams.set("limit", String(o.limit));
  if (s.kind === "view" && s.resolvedViewId) u.searchParams.set("viewId", s.resolvedViewId);
  if (s.kind === "search" && s.search) u.searchParams.set("search", s.search);
  // cursor 与 offset 互斥：有 cursor 发 cursor（on 档深页续点）；否则 offset>0 就发 offset。
  // 后者与档位无关——on 档的 deep_window_edge 正是靠显式 offset 顶出兼容窗口来触发 400，
  // 不能因为 useCursor 就把 offset 丢掉（否则会退化成首页 200，误判窗口守卫失效）。
  if (cont.cursor) u.searchParams.set("cursor", cont.cursor);
  else if (cont.offset > 0) u.searchParams.set("offset", String(cont.offset));
  return u.toString();
}

interface FireOutcome {
  sample: Sample;
  body: any;
}

async function fire(url: string, init: RequestInit | undefined, t0: number, timeoutMs: number, isWrite: boolean): Promise<FireOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let status = 0;
  let h = new Headers();
  let body: any = null;
  let timedOut = false;
  let errorCodeStr: string | null = null;
  try {
    const res = await fetch(url, { ...(init ?? {}), signal: ctrl.signal });
    status = res.status;
    h = res.headers;
    body = await res.json().catch(() => null);
  } catch (e) {
    timedOut = (e as Error).name === "AbortError";
    errorCodeStr = errorCode(e);
  } finally {
    clearTimeout(timer);
  }
  const ok = isWrite ? status === 201 : status >= 200 && status < 300;
  return {
    sample: {
      clientMs: performance.now() - t0,
      serveMs: headerNum(h, "x-gx-serve-ms"),
      physicalSql: headerNum(h, "x-gx-physical-sql"),
      prismaCalls: headerNum(h, "x-gx-prisma-calls"),
      rssBytes: headerNum(h, "x-gx-rss-bytes"),
      ok,
      status,
      timedOut,
      errorCode: errorCodeStr,
    },
    body,
  };
}

async function oneList(o: RunOptions, s: ResolvedScene, cont: { cursor: string | null; offset: number }): Promise<Sample> {
  const t0 = performance.now();
  const { sample } = await fire(listUrl(o, s, cont), { headers: { Authorization: `Bearer ${o.token}` } }, t0, o.timeoutMs, false);
  return sample;
}

async function oneWrite(o: RunOptions, s: ResolvedScene, seq: number): Promise<Sample> {
  const t0 = performance.now();
  const { sample } = await fire(
    `${o.baseUrl}/api/records?tableId=${o.tableId}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { [o.titleFieldId]: `${s.writeTitlePrefix}-${seq}` } }),
    },
    t0, o.timeoutMs, true,
  );
  return sample;
}

/** 深页续点：on 档顺序翻 cursor；off/shadow 档直接换算 offset。 */
async function continuationForDeep(o: RunOptions, s: ResolvedScene, page: number): Promise<{ cursor: string | null; offset: number }> {
  if (!useCursor(o)) return { cursor: null, offset: Math.max(0, page - 1) * o.limit };
  let cursor: string | null = null;
  for (let p = 0; p < Math.max(0, page - 1); p++) {
    const { body } = await fire(
      listUrl(o, s, { cursor, offset: p * o.limit }),
      { headers: { Authorization: `Bearer ${o.token}` } },
      performance.now(), o.timeoutMs, false,
    );
    cursor = body?.nextCursor ?? null;
    if (!cursor) break;
  }
  return { cursor, offset: 0 };
}

async function runPool<T>(n: number, concurrency: number, task: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(n);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      out[i] = await task(i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, n)) }, worker));
  return out;
}

/** 深翻窗口边缘：offset 顶到窗口（limit×5）再外一页；on 必 400，其余档 200，按期望判成功。 */
async function runDeepWindowEdge(o: RunOptions, s: ResolvedScene): Promise<ScenarioResult> {
  const overOffset = o.limit * 5 + o.limit;
  const expected = useCursor(o) ? 400 : 200;
  const cont = { cursor: null, offset: overOffset };
  const sample = await oneList(o, s, cont);
  // 用期望状态码覆盖通用 2xx 判定（on 档 400 是正确行为，不算失败）。
  sample.ok = sample.status === expected;
  return {
    scene: s.name, kind: s.kind, mode: `deep-edge:offset${overOffset}/expect${expected}`,
    desc: s.desc, stats: summarizeSamples([sample], sample.clientMs),
  };
}

/**
 * 混合读写：测量窗口内每个 worker 交替发 home 首页读与创建写（读:写=1:1）。
 * 写经真实写队列 + 同事务 sidecar；读在写并发下进行，检验 BUSY/锁竞争与读已提交稳定性。
 * 样本合并统计（读 2xx / 写 201 皆成功）；写后 drift 由 run-gate 离线对拍。
 */
async function runMixed(o: RunOptions, s: ResolvedScene): Promise<ScenarioResult> {
  for (let i = 0; i < Math.min(o.warmup, 20); i++) {
    await oneList(o, s, { cursor: null, offset: 0 });
  }
  let seq = 0;
  const wallStart = performance.now();
  const samples = await runPool(o.samples, o.concurrency, async (i) => {
    if (i % 2 === 0) return oneList(o, s, { cursor: null, offset: 0 });
    return oneWrite(o, s, ++seq);
  });
  const wallMs = performance.now() - wallStart;
  return {
    scene: s.name, kind: "mixed", mode: "read+write", desc: s.desc,
    stats: summarizeSamples(samples, wallMs),
  };
}

/** 跑一个场景：预热丢弃 →（可选深页 cursor）→ 并发采样。 */
export async function runScene(scene: ResolvedScene, o: RunOptions): Promise<ScenarioResult> {
  if (scene.name === "deep_window_edge") return runDeepWindowEdge(o, scene);
  if (scene.kind === "mixed") return runMixed(o, scene);

  const isWrite = scene.kind === "write";
  // 预热（串行，避免污染并发窗口；结果丢弃）。
  for (let i = 0; i < o.warmup; i++) {
    if (isWrite) await oneWrite(o, scene, -i - 1);
    else await oneList(o, scene, { cursor: null, offset: 0 });
  }

  let fixedCont: { cursor: string | null; offset: number } = { cursor: null, offset: 0 };
  if (!isWrite && scene.cursorPage && scene.cursorPage > 1) {
    // on 档优先用 run-gate 预置的边界游标（一次性只读定位，见 RunOptions.deepCursor）；
    // 未预置时才逐 HTTP 翻页（小库/兼容用，大库过慢）。off/shadow 直接换算 offset。
    if (useCursor(o) && o.deepCursor) {
      fixedCont = { cursor: o.deepCursor, offset: 0 };
    } else {
      fixedCont = await continuationForDeep(o, scene, scene.cursorPage);
    }
  }

  const wallStart = performance.now();
  const samples: Sample[] = isWrite
    ? await runPool(o.samples, o.concurrency, (i) => oneWrite(o, scene, i + 1))
    : await runPool(o.samples, o.concurrency, () => oneList(o, scene, fixedCont));
  const wallMs = performance.now() - wallStart;

  return {
    scene: scene.name,
    kind: scene.kind,
    mode: isWrite
      ? "write"
      : fixedCont.cursor || fixedCont.offset > 0
        ? `deep:p${scene.cursorPage ?? "?"}`
        : scene.config?.sorts?.length ? "keyset-sorted/wide" : "keyset-created/wide",
    desc: scene.desc,
    stats: summarizeSamples(samples, wallMs),
  };
}

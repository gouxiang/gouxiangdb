// M6/S6b e2e 共享种子与 MCP 客户端（纯 fetch，走真实 :3001，不经浏览器 mock）。
//
// 隔离原则：每次 run 注册一个带时间戳邮箱的一次性用户，自建独立 KB + 画布，
// 数据互不撞、可重复运行；afterAll 软删除（KB 连带 doc）。账号密码不进仓库（运行时生成）。
import type { Page } from "@playwright/test";

export const API_ORIGIN = process.env.E2E_API_ORIGIN ?? "http://localhost:3001";
export const WEB_ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:5173";

const TS = Date.now();
const EMAIL = `e2e-canvas-${TS}@gx.dev`;
const PASSWORD = "E2eCanvas!2026xyz";
const DISPLAY = "E2E画布临时账号";

let cached: SeedState | null = null;

export interface SeedState {
  userId: string;
  token: string;
  email: string;
  password: string;
  kbId: string;
  /** 带一个种子矩形的 golden 画布 */
  docId: string;
  pat: string;
}

async function jget<T = unknown>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * 种子请求的 429 有限重试（仅针对 dev/真服务认证限流的弹性，不放宽 golden）。
 *
 * 背景：apps/api/src/middleware/rateLimit.ts 对 signup/login/change-password 采用
 * 10 次/60 秒/IP 的固定窗口，dev 服务是生产限流姿态（非 NODE_ENV=test 不会关）。
 * Playwright 同机连续多轮（chromium+webkit 两 project、人工复跑）会在 60s 内叠加
 * >10 次 signup，轮到后启动的引擎时被 429，使种子链非确定性失败。
 *
 * 策略：仅当响应为 429 时，按响应头 Retry-After（秒，缺省保守 60s）等待后重试，
 * 最多重试 2 次；其它 4xx/5xx 立即抛（绝不把真实 bug 重试掉）。workers:1 已串行，
 * 无需跨 project 去抖。
 */
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_FALLBACK_SEC = 60;

function sleepSec(sec: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, sec) * 1000));
}

async function seedFetch(url: string, init?: RequestInit, label = "seed"): Promise<Response> {
  let res = await fetch(url, init);
  for (let attempt = 1; res.status === 429 && attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const headerSec = Number(res.headers.get("Retry-After"));
    const waitSec = Number.isFinite(headerSec) && headerSec > 0 ? headerSec : RATE_LIMIT_FALLBACK_SEC;
    // 限流窗口最长 60s；等待期间不发任何请求，避免继续计数。
    console.log(`[e2e] ${label} 收到 429，${waitSec}s 后重试（第 ${attempt}/${RATE_LIMIT_MAX_RETRIES} 次）`);
    await sleepSec(waitSec);
    res = await fetch(url, init);
  }
  return res;
}

/**
 * 真实注册一个一次性用户并建 KB + 空画布（content="[]"），返回 JWT 与 PAT。
 * 走真实 REST（最接近真实用户注册/创建路径），不直接写库。
 */
export async function ensureSeed(): Promise<SeedState> {
  if (cached) return cached;

  const auth = await jget<{ token: string; user: { id: string } }>(
    await seedFetch(
      `${API_ORIGIN}/api/auth/signup`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: DISPLAY }),
      },
      "signup",
    ),
  );

  const kb = await jget<{ knowledgeBase: { id: string } }>(
    await seedFetch(
      `${API_ORIGIN}/api/kb`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ name: `E2E Golden 库 ${TS}` }),
      },
      "create-kb",
    ),
  );

  const doc = await jget<{ doc: { id: string } }>(
    await seedFetch(
      `${API_ORIGIN}/api/kb/${kb.knowledgeBase.id}/docs`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({
          kind: "canvas",
          title: `E2E Golden 画布 ${TS}`,
        }),
      },
      "create-doc",
    ),
  );

  const pat = await jget<{ token: string }>(
    await seedFetch(
      `${API_ORIGIN}/api/v1/pats`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({
          name: `e2e-golden-${TS}`,
          scopes: ["canvas:read", "canvas:write"],
          expiresInDays: 30,
        }),
      },
      "create-pat",
    ),
  );

  cached = {
    userId: auth.user.id,
    token: auth.token,
    email: EMAIL,
    password: PASSWORD,
    kbId: kb.knowledgeBase.id,
    docId: doc.doc.id,
    pat: pat.token,
  };
  return cached;
}

// ---- MCP JSON-RPC（SSE 兼容 accept 头，确保返 JSON 而非 event-stream 包裹） ----

function mcpHeaders(pat: string): HeadersInit {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${pat}`,
  };
}

async function mcpCall<T = unknown>(
  pat: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_ORIGIN}/mcp`, {
    method: "POST",
    headers: mcpHeaders(pat),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const envelope = (await res.json()) as {
    result?: { isError?: boolean; content: Array<{ text: string }> };
    error?: { code: number; message: string };
  };
  if (envelope.error) throw new Error(`MCP error ${envelope.error.code}: ${envelope.error.message}`);
  const text = envelope.result?.content[0]?.text ?? "";
  const parsed = JSON.parse(text) as T & { code?: string; message?: string };
  if (envelope.result?.isError) {
    throw new Error(`MCP tool isError: ${text}`);
  }
  return parsed;
}

export interface CommitReceipt {
  ok: boolean;
  contentVersion: number;
  elementCount: number;
  createdIds: string[];
  connectedIds?: string[];
  updatedIds?: string[];
  movedIds?: string[];
  deletedIds?: string[];
}

export interface BoardElement {
  id?: string;
  type?: string;
  shape?: string;
  points?: number[][];
  fill?: string;
  strokeColor?: string;
  strokeWidth?: number;
  gxNote?: string;
  [k: string]: unknown;
}

export interface BoardSnapshot {
  elementCount: number;
  contentVersion: number;
  elements: BoardElement[];
}

export const rect = (extra: Record<string, unknown> = {}) => ({
  type: "geometry",
  shape: "rectangle",
  points: [
    [10, 10],
    [110, 90],
  ],
  ...extra,
});

/** 尾插一批元素（confirm:true）。 */
export function commitElements(
  pat: string,
  docId: string,
  ops: Array<Record<string, unknown>>,
  baseVersion?: number,
) {
  return mcpCall<CommitReceipt>(pat, "canvas.commit_elements", {
    docId,
    ops,
    ...(baseVersion === undefined ? {} : { baseVersion }),
    confirm: true,
  });
}

export function getBoard(pat: string, docId: string) {
  return mcpCall<BoardSnapshot>(pat, "canvas.get_board", { docId });
}

/** 浏览器真实 UI 登录：填登录/注册表单后提交，落到首页。 */
export async function loginViaUi(page: Page, seed: SeedState): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/login`);
  // 登录页默认可能是“登录”态；若有切到注册的入口不影响——已注册账号走登录表单。
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', seed.email);
  await page.fill('input[type="password"]', seed.password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => undefined),
    page.keyboard.press("Enter"),
  ]);
  // 登录成功后离开 /login
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

export function canvasUrl(seed: SeedState): string {
  return `${WEB_ORIGIN}/kb/${seed.kbId}/canvas/${seed.docId}`;
}

/** 清理：尽力软删 KB（失败不致命——一次性数据，本地 dev 库）。 */
export async function cleanupSeed(): Promise<void> {
  if (!cached) return;
  try {
    await fetch(`${API_ORIGIN}/api/kb/${cached.kbId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${cached.token}` },
    });
  } catch {
    /* 一次性隔离数据，忽略 */
  }
  cached = null;
}

export function seedEmailForDebug(): string {
  return EMAIL;
}

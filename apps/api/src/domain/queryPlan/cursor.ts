// apps/api/src/domain/queryPlan/cursor.ts
// M1/S7 keyset 不透明游标编解码。令牌是 base64url(JSON{ v:1, c:createdAt_ms, id })。
// - 不透明：客户端只回传、不解析；服务端解码并严格校验，非法令牌 400。
// - 防注入：c/id 只作为绑定参数（S2/S6 游标谓词），绝不拼进 SQL 文本。
// - 仅刻画 (createdAt,id) 复合键（Prisma 把 DateTime 存为 epoch 毫秒整数）；
//   带排序值的 keyset 续点在 M1 用「有序 id 序列按 lastId 定位」，不进令牌。

export interface KeysetToken {
  /** 上一页最后一条记录的 createdAt（epoch 毫秒）。 */
  c: number;
  /** 上一页最后一条记录的 id（同毫秒 tie-break）。 */
  id: string;
}

/**
 * 游标非法（坏 base64/结构不符/值越界）。独立于 guards.HttpError，避免 queryPlan
 * 纯模块牵出 db.js（测试 prisma 单例陷阱）；路由层捕获后转 400 统一信封。
 */
export class InvalidCursorError extends Error {
  constructor(message = "游标无效或已过期，请回到第一页重新浏览") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/**
 * 老客户端 offset 超过兼容窗口（默认 5 页）。keyset 不支持 SQL OFFSET 深翻，
 * 路由层捕获后转 400，引导改用 cursor 翻页。
 */
export class OffsetWindowError extends Error {
  constructor(limit: number, pages: number) {
    super(`翻页过深（offset 超出兼容窗口 ${limit * pages} 行），请使用游标（cursor）翻页`);
    this.name = "OffsetWindowError";
    this.limit = limit;
    this.pages = pages;
  }
  readonly limit: number;
  readonly pages: number;
}

const VERSION = 1;

function toBase64Url(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}

function fromBase64Url(token: string): string {
  return Buffer.from(token, "base64url").toString("utf8");
}

/** 编码游标（首页传 null → 返回 null）。 */
export function encodeCursor(tok: KeysetToken | null): string | null {
  if (!tok) return null;
  return toBase64Url(JSON.stringify({ v: VERSION, c: tok.c, id: tok.id }));
}

/**
 * 解码并严格校验游标。合法返回 KeysetToken；非法（非字符串/坏 base64/结构不符/
 * c 非有限整数/id 非非空串）返回 null（调用方据此 400，不猜测、不回退到全表）。
 */
export function decodeCursor(raw: unknown): KeysetToken | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== VERSION) return null;
  const c = o.c;
  const id = o.id;
  if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) return null;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  return { c, id };
}

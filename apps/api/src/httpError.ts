// apps/api/src/httpError.ts
// 可预期的 4xx 错误：状态码 + 人话消息（+ 可选机器码）。
//
// 从 guards.ts 抽出来的唯一原因：domain/** 需要抛 4xx，但 domain 不能 import guards.ts
// （那里带 Hono 的 Context，会把 Web 框架拖进纯领域层，也会和 guards → domain/authz
// 的既有依赖方向成环）。本模块零依赖，两边都能用：
//   - guards.ts 的 errorResponse 按 instanceof / status 映射为统一错误信封；
//   - domain/authz/libraryPolicy.ts、libraryScopeConfig.ts 直接 new HttpError(403, ...)。

export class HttpError extends Error {
  /** 可选机器可读错误码（不传时按状态码回落 BAD_REQUEST/CONFLICT 等）。 */
  code?: string;
  constructor(public status: number, message: string, code?: string) {
    super(message);
    if (code) this.code = code;
  }
}

export function errorCodeForStatus(status: number): string {
  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401: return "UNAUTHORIZED";
    case 403: return "FORBIDDEN";
    case 404: return "NOT_FOUND";
    case 409: return "CONFLICT";
    case 413: return "PAYLOAD_TOO_LARGE";
    case 429: return "TOO_MANY_REQUESTS";
    default: return `HTTP_${status}`;
  }
}

// M6/S1 /api/v1/pats REST（挂 v1 鉴权链 requireActiveUser；本人限定）。
//
// 权威依据：M6-implementation-plan §5.2（椭圆契约与错误码）、§6（错误码只增）、C-3（有效期/前缀）。
//
// 契约：
//   POST   /api/v1/pats  body {name(≤60), scopes[六位子集,非空], expiresInDays?: 30|90|365|null}
//     -> 201 { id, name, scopes, token（**仅此一次**）, tokenPrefix, expiresAt, createdAt }
//   GET    /api/v1/pats -> 200 [PatMetadata]（绝无 token/tokenHash；tokenPrefix 仅前 14 字符）
//   DELETE /api/v1/pats/:id -> 204（仅本人行；非本人/不存在统一 404 PAT_NOT_FOUND，不泄漏存在性）
//
// 门控：随 v1 挂载（C-5 定稿：/api/v1/pats 与 /mcp 同受 GX_ENTERPRISE_ORG；off 即 404）。
// 限流：C-1 的 PAT 敏感档（30/60s/人）随 S2 的 GX_MCP_RATE_* 配置组落地；本片由全局 /api 兜底档覆盖。

import { Hono } from "hono";
import { HttpError } from "../../guards.js";
import { audit } from "../../audit/emit.js";
import { createPat, listPats, revokePat } from "../../mcp/pat/patService.js";
import {
  PAT_DEFAULT_EXPIRY_DAYS, PatValidationError, validateExpiry, validateName, validateScopes,
} from "../../mcp/pat/tokens.js";

export const patRoutes = new Hono();

/** PatValidationError（400 三码）原样映射为 {@link HttpError}，其余错误透传。 */
function rethrow(err: unknown): never {
  if (err instanceof PatValidationError) throw new HttpError(400, err.message, err.code);
  throw err;
}

patRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const name = validateName(raw.name);
    const scopes = validateScopes(raw.scopes);
    // C-3：缺省 90 天；显式 null = 永不过期（用 hasOwnProperty 区分"未携带"与"显式 null"）。
    const expiresInDays = Object.prototype.hasOwnProperty.call(raw, "expiresInDays")
      ? validateExpiry(raw.expiresInDays)
      : PAT_DEFAULT_EXPIRY_DAYS;
    const { pat, plaintext } = await createPat(userId, { name, scopes, expiresInDays });
    audit(c, {
      event: "mcp_pat_create",
      status: 201,
      actorId: userId,
      // 脱敏注意：审计脱敏命中键含 "token"，故此处用 prefix（非密钥，C-3 明确不可认证）。
      detail: { patId: pat.id, name: pat.name, prefix: pat.tokenPrefix, scopes: pat.scopes, expiresAt: pat.expiresAt },
    });
    return c.json(
      {
        id: pat.id, name: pat.name, scopes: pat.scopes,
        token: plaintext, tokenPrefix: pat.tokenPrefix,
        expiresAt: pat.expiresAt, createdAt: pat.createdAt,
      },
      201,
    );
  } catch (err) {
    return rethrow(err);
  }
});

patRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  return c.json(await listPats(userId));
});

patRoutes.delete("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const patId = c.req.param("id");
  const revoked = await revokePat(userId, patId);
  if (!revoked) {
    // 非本人 / 不存在 / 已吊销：统一 404，不泄漏存在性（§5.2）。
    throw new HttpError(404, "令牌不存在", "PAT_NOT_FOUND");
  }
  audit(c, { event: "mcp_pat_revoke", status: 204, actorId: userId, detail: { patId } });
  return c.body(null, 204);
});

-- M6/S1 迁移 #23：鉴权 MCP 服务基座两表（personal_access_tokens + mcp_idempotency）。
--
-- 纪律（M6-implementation-plan §4.3/§5.1，只增不删，编号在 M5 迁移 #21/#22 之后）：
--   1. 两表同批落库（C-8 定稿：PAT 表 + S7 幂等表；「建议同批第二迁移」已在 §4.5 允许）。
--      本迁移只建结构，无回填（新表）。
--   2. 普通 rowid 表、TEXT/DATETIME 标准类型；时间沿用 Prisma DateTime（TEXT）。
--      不用 WITHOUT ROWID / 专有函数，保 SPEC:60 的 PostgreSQL 平移通道。
--   3. personal_access_tokens.userId 对 users(id) ON DELETE CASCADE（删除用户级联清 PAT，
--      与既有 members/kb_members 的级联声明方式一致）。停用用户不删行，走应用层
--      lifecycle.disableUser 同事务批量 revokedAt 置位（C-4），故本表无 status 列。
--   4. 密钥纪律（C-3）：库存 tokenHash（sha256 hex，@unique 等值查）+ tokenPrefix（明文前 14
--      字符，含 gxpat_ 前缀，仅辨识用、不可认证）；【随机段与明文永不入库】。
--   5. mcp_idempotency 无 FK（PAT 行可能先于幂等行被清；表极小，过期行定期 DELETE 即可），
--      键 = key（patId + tool + requestId 组合串），24h 窗语义由应用层保证。
--   6. 幂等只增：CREATE TABLE/INDEX IF NOT EXISTS，空库 deploy 与存量库重放都安全。
--
-- down：prisma/docs/rollback/20260918090000_mcp_pat.down.sql（DROP 两表）。

-- ---------------------------------------------------------------------------
-- 1) personal_access_tokens（个人访问令牌）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "personal_access_tokens" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "userId"      TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    -- 明文前 14 字符（"gxpat_" + 8 随机字符）：列表辨识用，不可认证（C-3）。
    "tokenPrefix" TEXT NOT NULL,
    -- sha256(明文) hex；@unique 等值索引，认证即等值点查。
    "tokenHash"   TEXT NOT NULL,
    -- JSON 数组字符串，如 ["record:read","doc:read"]（SQLite 无原生数组）。
    "scopes"      TEXT NOT NULL,
    -- null = 永不过期（C-3：默认 90 天，可选 30/90/365 与 null）。
    "expiresAt"   DATETIME,
    -- 时间戳而非 boolean：revoked = revokedAt IS NOT NULL；停用账号同事务置位（C-4）。
    "revokedAt"   DATETIME,
    "lastUsedAt"  DATETIME,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "personal_access_tokens_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 认证热路径：tokenHash 等值点查（唯一）。
CREATE UNIQUE INDEX IF NOT EXISTS "personal_access_tokens_tokenHash_key"
    ON "personal_access_tokens"("tokenHash");
-- 列表/停用联动：按 userId 取该用户全部 PAT。
CREATE INDEX IF NOT EXISTS "personal_access_tokens_userId_idx"
    ON "personal_access_tokens"("userId");

-- ---------------------------------------------------------------------------
-- 2) mcp_idempotency（M6/S7 写工具 requestId 幂等；本片建表不读写）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "mcp_idempotency" (
    "key"          TEXT NOT NULL PRIMARY KEY,
    "patId"        TEXT NOT NULL,
    "tool"         TEXT NOT NULL,
    "responseJson" TEXT NOT NULL,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 过期行清理（runbook 定期 DELETE：createdAt < now-24h）。
CREATE INDEX IF NOT EXISTS "mcp_idempotency_createdAt_idx"
    ON "mcp_idempotency"("createdAt");

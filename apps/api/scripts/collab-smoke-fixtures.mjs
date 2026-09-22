// apps/api/scripts/collab-smoke-fixtures.mjs
// collab-smoke.mjs 的环境与夹具半边：临时库、用户/角色/文档夹具、JWT 签发、端口与就绪探测。
// （按单文件 ≤300 行的仓库纪律从主脚本拆出，无新增依赖。）

import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const Database = require("better-sqlite3");

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const API_DIR = path.resolve(HERE, "..");
export const DEV_DB = path.join(API_DIR, "prisma", "dev.db");

/** 读 .env（只需要 JWT_SECRET：本地签发与服务端验签同一把钥匙）。 */
export function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** 与 domain/org/authState.ts:44 issueToken 同载荷（{userId,tv,iat,exp}）、同算法（HS256）。 */
export function signJwt(userId, tv, secret) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ userId, tv, iat: now, exp: now + 3600 }));
  const sig = b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

/** 把 dev.db 备份到临时目录（不污染开发库），返回临时目录与库路径。 */
export async function prepareTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-collab-smoke-"));
  const dbPath = path.join(tmpDir, "smoke.db");
  const src = new Database(DEV_DB, { readonly: true });
  await src.backup(dbPath);
  src.close();
  return { tmpDir, dbPath };
}

/**
 * 插入本次专用夹具。
 * 档位选择的依据（domain/authz/libraryPolicy.ts）：
 *   - role_owner = 超级管理员 → SUPER_ACCESS 短路，对该库可读可写 → role=editor；
 *   - role_admin = 管理员     → 硬规则 2「进得了所有库」，但对该库无 canManage，
 *     内容档位回落 READONLY_TABLE_ACCESS（read=true/update=false）→ role=viewer。
 * 这样只读档位不需要改任何既有权限数据就能稳定造出来。
 */
export function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  const now = "2026-09-23 10:00:00";
  const editorId = "u_smoke_editor";
  const viewerId = "u_smoke_viewer";
  db.exec("DELETE FROM users WHERE id IN ('u_smoke_editor','u_smoke_viewer')");
  db.exec("DELETE FROM role_assignments WHERE subjectId IN ('u_smoke_editor','u_smoke_viewer')");
  db.exec("DELETE FROM kb_docs WHERE id = 'doc_smoke'");
  db.exec("DELETE FROM knowledge_bases WHERE id = 'kb_smoke'");
  const insUser = db.prepare(
    `INSERT INTO users (id,email,displayName,passwordHash,createdAt,status,tokenVersion,mustChangePassword)
     VALUES (?,?,?,?,?,'ACTIVE',0,0)`,
  );
  insUser.run(editorId, "smoke-editor@gx.local", "冒烟编辑", "x", now);
  insUser.run(viewerId, "smoke-viewer@gx.local", "冒烟只读", "x", now);
  const insRole = db.prepare(
    `INSERT INTO role_assignments (id,roleId,subjectType,subjectId,scopeType,createdAt,createdBy)
     VALUES (?,?,'user',?,'workspace',?,'smoke')`,
  );
  insRole.run(`ra_smoke_${randomUUID().slice(0, 6)}`, "role_owner", editorId, now);
  insRole.run(`ra_smoke_${randomUUID().slice(0, 6)}`, "role_admin", viewerId, now);
  db.prepare(
    `INSERT INTO knowledge_bases (id,name,createdBy,createdAt,updatedAt) VALUES ('kb_smoke','冒烟库',?,?,?)`,
  ).run(editorId, now, now);
  db.prepare(
    `INSERT INTO kb_docs (id,kbId,kind,title,content,searchText,contentVersion,createdBy,updatedBy,createdAt,updatedAt)
     VALUES ('doc_smoke','kb_smoke','doc','冒烟文档','','',0,?,?,?,?)`,
  ).run(editorId, editorId, now, now);
  db.close();
}

export const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });

export async function waitHealth(port) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("API 进程 90s 内未就绪");
}

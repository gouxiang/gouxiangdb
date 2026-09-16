// M5/S10 AC-M5-3 权限即时失效对抗共享夹具（非 .test.ts，不被 vitest 收集）。
// 真迁移临时库 + 真 createApp + 真 JWT + 真 search.db（装配同 m5-admin-search：env 冻结 ->
// migrate -> globalThis.__gx_prisma -> vi.resetModules -> 动态 import app）。cloud stub fetch 只
// 放行 /v1/embeddings（确定性 4 维向量，零真外网）；off 不设 GX_EMBEDDING_*、不开 vec0。owner 执行变更。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import type { EmbeddingProvider } from "../../../domain/search/embedding/types.js";
import type { SearchStore } from "../../../domain/search/searchStore.js";

const JWT_SECRET = "m5-s10-ac3-secret-at-least-16-chars";
const TOKEN_TTL = 7 * 24 * 60 * 60;

/**
 * 确定性 4 维单位向量：取文本首个 AC3 标记词哈希。查询 q 与含同一标记的 chunk 向量恒等（距离 0），
 * 保证 vector 路目标实体确定性排 KNN 首位；不同实体标记不同；收权后即便距离 0 也被 allowed 剔除。
 */
export function deterministicVec4(text: string): number[] {
  const marker = text.match(/AC3[A-Za-z0-9]+/)?.[0] ?? text;
  let h = 0;
  for (let i = 0; i < marker.length; i += 1) h = (h * 31 + marker.charCodeAt(i)) >>> 0;
  const v = [0.3 + (h % 5) / 10, 0.3 + ((h >> 3) % 5) / 10, 0.3 + ((h >> 6) % 5) / 10, 0.3 + ((h >> 9) % 5) / 10];
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function seedCloudProvider(): EmbeddingProvider {
  return {
    mode: "cloud", model: "ac3-mock", dim: 0, batchSize: 64,
    async embed(texts: readonly string[]) {
      return texts.map((t) => Float32Array.from(deterministicVec4(t)));
    },
    async health() { return { ok: true }; },
    async dispose() { return undefined; },
  } as unknown as EmbeddingProvider;
}

export interface Ac3Options { mode: "cloud" | "off"; label: string }

export interface SearchSnapshot {
  chunks: number; fts: number; vec: number | null;
  /** chunks 行指纹（chunkId:body字节长，按 rowid 序）；授权变更前后必须逐字节不变。 */
  checksum: string;
}

export interface RecordRes {
  baseId: string; tableId: string; nodeId: string; recordId: string;
  primaryField: string; secretField: string; pubField: string;
  primaryWord: string; secretWord: string; pubWord: string;
}
export interface DocRes { kbId: string; docId: string; nodeId: string; kbNodeId: string; word: string }

export interface Ac3World {
  mode: "cloud" | "off";
  prisma: PrismaClient;
  app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  token: (userId: string, tv?: number) => Promise<string>;
  mkUser: (id: string) => Promise<void>;
  search: (userId: string, q: string, mode?: "auto" | "fts" | "vector") => Promise<{ status: number; body: any }>;
  putPolicies: (nodeId: string, body: unknown) => Promise<Response>;
  patchInheritance: (nodeId: string, value: boolean, confirmed?: boolean) => Promise<Response>;
  createGroup: (name: string, parentId?: string | null) => Promise<string>;
  moveNode: (nodeId: string, newParentId: string, confirmed?: boolean) => Promise<Response>;
  deleteGroupRetain: (groupId: string) => Promise<Response>;
  createDept: (name: string) => Promise<string>;
  assignDepartments: (userId: string, body: { add?: string[]; remove?: string[] }) => Promise<Response>;
  createCustomRole: (name: string) => Promise<string>;
  replaceRoleGrants: (roleId: string, subjects: Array<{ subjectType: "user" | "dept"; subjectId: string }>) => Promise<Response>;
  disable: (userId: string) => Promise<Response>;
  reactivate: (userId: string) => Promise<Response>;
  mkRecord: (prefix: string) => Promise<RecordRes>;
  /** parentDocId 给出时必须同时给 kbId（父子 doc 同库）；否则新建 kb。 */
  mkDoc: (prefix: string, opts?: { parentDocId?: string; kbId?: string }) => Promise<DocRes>;
  snapshotSearch: () => SearchSnapshot;
  chunksForEntity: (entityType: string, entityId: string) => number;
  /** 全片证明：授权翻转期间不得触发任何 reindex（空闲恒 null）。 */
  currentReindex: () => Promise<unknown> | null;
  cleanup: () => Promise<void>;
}

const ENV_KEYS = [
  "GX_M5_SEARCH", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV", "DATABASE_URL", "GX_DATA_DIR",
  "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV", "GX_RATE_LIMIT", "GX_SEARCH_DB_PATH",
  "GX_EMBEDDING_MODE", "GX_EMBEDDING_API_KEY", "GX_EMBEDDING_BASE_URL",
  "GX_EMBEDDING_MODEL", "GX_AUTH_STATE_TTL_MS",
] as const;

export async function setupAc3(opts: Ac3Options): Promise<Ac3World> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  const prevFetch = globalThis.fetch;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gx-m5s10-${opts.label}-`));
  const searchPath = path.join(tmpDir, "search.db");
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(tmpDir, "ac3.db")}`, GX_DATA_DIR: tmpDir,
    GX_AUDIT_DIR: path.join(tmpDir, ".audit"), GX_SEARCH_DB_PATH: searchPath,
    JWT_SECRET, NODE_ENV: "test", GX_RATE_LIMIT: "off", GX_AUTH_STATE_TTL_MS: "0",
    GX_M5_SEARCH: "on",
  });
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  if (opts.mode === "cloud") {
    Object.assign(process.env, {
      GX_EMBEDDING_MODE: "cloud", GX_EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      GX_EMBEDDING_MODEL: "ac3-mock", GX_EMBEDDING_API_KEY: "ac3-test-key",
    });
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (!u.endsWith("/v1/embeddings")) throw new Error(`AC3 未预期的出网请求: ${u}`);
      let inputs = ["ac3-query"];
      try {
        const parsed = JSON.parse(init?.body ?? "{}") as { input?: unknown };
        if (typeof parsed.input === "string") inputs = [parsed.input];
        else if (Array.isArray(parsed.input)) inputs = parsed.input.map(String);
      } catch { /* 保持兜底向量 */ }
      const data = inputs.map((q, i) => ({ index: i, embedding: deterministicVec4(q) }));
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  } else {
    ["GX_EMBEDDING_MODE", "GX_EMBEDDING_API_KEY", "GX_EMBEDDING_BASE_URL", "GX_EMBEDDING_MODEL"].forEach((k) => delete process.env[k]);
  }

  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const { vi } = await import("vitest");
  vi.resetModules();
  const appMod = await import("../../../app.js");
  const app = appMod.createApp().app as unknown as Ac3World["app"];
  const storeMod = await import("../../../domain/search/searchStore.js");
  const { extractEntity } = await import("../../../domain/search/entityExtract.js");
  const { applyUpsert } = await import("../../../domain/search/indexerDerive.js");
  // resetModules 之后动态取，与 app 内 admin 路由同一模块图单例（inflight 锁共享）。
  const reindexMod = await import("../../../domain/search/reindex.js");

  const mkUser: Ac3World["mkUser"] = async (id) => {
    await prisma.user.create({ data: {
      id, email: `${id}@ac3.test`, displayName: id, passwordHash: await bcrypt.hash("password123", 10),
      status: "ACTIVE", workspaceId: "ws_default",
    } });
  };
  await mkUser("ac3-owner");
  await prisma.roleAssignment.create({ data: {
    roleId: "role_owner", subjectType: "user", subjectId: "ac3-owner", scopeType: "workspace", createdBy: "seed",
  } });

  const token = async (userId: string, tv = 0): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return sign({ userId, tv, iat: now, exp: now + TOKEN_TTL }, JWT_SECRET, "HS256");
  };
  const ownerAuth = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await token("ac3-owner")}`, "Content-Type": "application/json",
  });

  // 播种用独立写连接（app 单例首查才惰性打开）；关前 checkpoint TRUNCATE 落盘，app 单例另开可见。
  const seedAsync = async (fn: (s: SearchStore) => Promise<void>): Promise<void> => {
    const store = storeMod.openSearchStore({ filePath: searchPath, appDir: process.cwd(), tryLoadVec: opts.mode === "cloud" });
    try { await fn(store); store.db.pragma("wal_checkpoint(TRUNCATE)"); } finally { store.close(); }
  };
  const syncNav = async (): Promise<void> => {
    const sync = await import("../../../domain/nav/sync.js");
    await prisma.$transaction((tx) => sync.syncNavFromEntitiesTx(tx));
  };
  const derive = (entity: Promise<Awaited<ReturnType<typeof extractEntity>>>): Promise<void> =>
    seedAsync(async (store) => {
      await applyUpsert(store, await entity, {
        workspaceId: "ws_default",
        mode: opts.mode === "cloud" ? "cloud" : "off",
        provider: opts.mode === "cloud" ? seedCloudProvider() : null,
      });
    });

  let seq = 0;
  const mkRecord: Ac3World["mkRecord"] = async (prefix) => {
    seq += 1;
    const p = `${prefix}_${seq}`;
    const baseId = `${p}_b`, tableId = `${p}_t`, primaryField = `${p}_f0`, secretField = `${p}_f1`, pubField = `${p}_f2`, recordId = `${p}_r`;
    // 每字段 marker 前缀（T/S/P）唯一，向量路搜索某字段词时确定性只与该字段 chunk 距离 0。
    const primaryWord = `AC3Z${seq}T标题主词ZT${seq}`, secretWord = `AC3Z${seq}S私密SECRETKWS${seq}`, pubWord = `AC3Z${seq}P公开PUBLICKWP${seq}`;
    await prisma.base.create({ data: { id: baseId, name: `${p} 库`, createdBy: "ac3-owner" } });
    await prisma.table.create({ data: { id: tableId, baseId, name: `${p} 表`, primaryFieldId: primaryField, createdBy: "ac3-owner" } });
    await prisma.field.createMany({ data: [
      { id: primaryField, tableId, name: "主字段", type: "singleLineText", order: 0 },
      { id: secretField, tableId, name: "私密字段", type: "longText", order: 1 },
      { id: pubField, tableId, name: "公开字段", type: "longText", order: 2 },
    ] });
    await prisma.record.create({ data: {
      id: recordId, tableId, createdBy: "ac3-owner", updatedBy: "ac3-owner",
      fields: JSON.stringify({ [primaryField]: primaryWord, [secretField]: secretWord, [pubField]: pubWord }),
    } });
    await syncNav();
    await derive(extractEntity(prisma, { entityType: "record", entityId: recordId, version: 1n }, 50));
    return { baseId, tableId, nodeId: `nav_table_${tableId}`, recordId, primaryField, secretField, pubField, primaryWord, secretWord, pubWord };
  };

  const mkDoc: Ac3World["mkDoc"] = async (prefix, docOpts) => {
    seq += 1;
    const p = `${prefix}_${seq}`;
    const kbId = docOpts?.kbId ?? `${p}_kb`;
    const docId = `${p}_doc`;
    const word = `AC3DOC${seq}继承独有词DOCKW${seq}`;
    if (!docOpts?.kbId) await prisma.knowledgeBase.create({ data: { id: kbId, name: `${p} 知识库`, createdBy: "ac3-owner" } });
    await prisma.kbDoc.create({ data: {
      id: docId, kbId, kind: "doc", title: `${p} 文档标题`,
      content: `# ${p} 标题\n\n正文段落 ${word} 内容。`, searchText: word,
      parentId: docOpts?.parentDocId ?? null, createdBy: "ac3-owner", updatedBy: "ac3-owner" },
    });
    await syncNav();
    await derive(extractEntity(prisma, { entityType: "doc", entityId: docId, version: 0n }, 50));
    return { kbId, docId, nodeId: `nav_doc_${docId}`, kbNodeId: `nav_kb_${kbId}`, word };
  };

  const search: Ac3World["search"] = async (userId, q, mode = "auto") => {
    const res = await app.request(`/api/v1/search?q=${encodeURIComponent(q)}&mode=${mode}`,
      { headers: { Authorization: `Bearer ${await token(userId)}` } });
    return { status: res.status, body: await res.json() };
  };
  const putPolicies: Ac3World["putPolicies"] = async (nodeId, body) =>
    app.request(`/api/v1/nodes/${nodeId}/policies`, { method: "PUT", headers: await ownerAuth(), body: JSON.stringify(body) });
  const patchInheritance: Ac3World["patchInheritance"] = async (nodeId, value, confirmed = true) =>
    app.request(`/api/v1/nodes/${nodeId}/inheritance`, {
      method: "PATCH", headers: await ownerAuth(), body: JSON.stringify({ value, confirmed }),
    });
  const postCreatedId = async (url: string, body: unknown, label: string): Promise<string> => {
    const res = await app.request(url, { method: "POST", headers: await ownerAuth(), body: JSON.stringify(body) });
    if (res.status !== 201) throw new Error(`${label} ${res.status}: ${await res.text()}`);
    return (await res.json() as { id: string }).id;
  };
  const createGroup: Ac3World["createGroup"] = (name, parentId = null) =>
    postCreatedId("/api/v1/nav/groups", { name, ...(parentId ? { parentId } : {}) }, "createGroup");
  const moveNode: Ac3World["moveNode"] = async (nodeId, newParentId, confirmed = true) =>
    app.request(`/api/v1/nodes/${nodeId}/move`, {
      method: "POST", headers: await ownerAuth(), body: JSON.stringify({ newParentId, confirmed }),
    });
  const deleteGroupRetain: Ac3World["deleteGroupRetain"] = async (groupId) =>
    app.request(`/api/v1/nav/groups/${groupId}?strategy=retain`, { method: "DELETE", headers: await ownerAuth() });
  const createDept: Ac3World["createDept"] = (name) =>
    postCreatedId("/api/v1/org/departments", { name }, "createDept");
  const assignDepartments: Ac3World["assignDepartments"] = async (userId, body) =>
    app.request(`/api/v1/org/members/${userId}/departments`, { method: "POST", headers: await ownerAuth(), body: JSON.stringify(body) });
  const createCustomRole: Ac3World["createCustomRole"] = (name) =>
    postCreatedId("/api/v1/org/roles", { name, actions: [] }, "createCustomRole");
  const replaceRoleGrants: Ac3World["replaceRoleGrants"] = async (roleId, subjects) =>
    app.request(`/api/v1/org/roles/${roleId}/assignments`, { method: "PUT", headers: await ownerAuth(), body: JSON.stringify({ subjects }) });
  const disable: Ac3World["disable"] = async (userId) =>
    app.request(`/api/v1/org/members/${userId}/disable`, { method: "POST", headers: await ownerAuth() });
  const reactivate: Ac3World["reactivate"] = async (userId) =>
    app.request(`/api/v1/org/members/${userId}/reactivate`, { method: "POST", headers: await ownerAuth() });

  // 计数/指纹走 openSearchStore：vec_chunks 是 vec0 虚表，裸连接未加载扩展会 no such module。
  const withStore = <T,>(fn: (s: SearchStore) => T): T => {
    const s = storeMod.openSearchStore({ filePath: searchPath, appDir: process.cwd(), tryLoadVec: true });
    try { return fn(s); } finally { s.close(); }
  };
  const snapshotSearch: Ac3World["snapshotSearch"] = () => withStore((s) => {
    const one = (sql: string): number => (s.db.prepare(sql).get() as { c: number }).c;
    // chunks(chunkId:version:seq:length) + fts 正文字节长联合指纹，证明授权变更不触碰任何物理行。
    const rows = s.db.prepare(
      `SELECT c.chunkId AS id, c.version AS v, c.seq AS q, c.length AS l, length(f.body) AS bl
       FROM chunks c LEFT JOIN fts_chunks f ON f.chunkId = c.chunkId ORDER BY c.rowid`,
    ).all() as Array<{ id: string; v: number; q: number; l: number; bl: number | null }>;
    const hasVec = s.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'").get() !== undefined;
    return {
      chunks: one("SELECT COUNT(*) AS c FROM chunks"), fts: one("SELECT COUNT(*) AS c FROM fts_chunks"),
      vec: opts.mode === "cloud" && hasVec ? one("SELECT COUNT(*) AS c FROM vec_chunks") : null,
      checksum: rows.map((r) => `${r.id}:${r.v}:${r.q}:${r.l}:${r.bl ?? "-"}`).join("|"),
    };
  });
  const chunksForEntity: Ac3World["chunksForEntity"] = (entityType, entityId) => withStore((s) =>
    (s.db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE entityType=? AND entityId=?").get(entityType, entityId) as { c: number }).c);
  const cleanup = async (): Promise<void> => {
    storeMod.closeSearchStore();
    await prisma.$disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    globalThis.fetch = prevFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  return {
    mode: opts.mode, prisma, app, token, mkUser, search, putPolicies, patchInheritance, createGroup,
    moveNode, deleteGroupRetain, createDept, assignDepartments, createCustomRole, replaceRoleGrants,
    disable, reactivate, mkRecord, mkDoc, snapshotSearch, chunksForEntity,
    currentReindex: () => reindexMod.currentReindex(), cleanup,
  };
}

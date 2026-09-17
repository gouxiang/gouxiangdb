// M5/S12 AC-M5-1 降级/损坏自愈 + AC-M5-5 零外网共享夹具（非 .test.ts，不被收集）。
//
// 真迁移临时主库 + 真 createApp + 真 JWT + 真物理 search.db（装配纪律同 m5-ac-m5-3）：
// env 冻结 -> prisma migrate deploy -> globalThis.__gx_prisma -> vi.resetModules -> 动态 import app。
// cloud 形态用【可控 fetch 规则】代替真外网：controlled=确定性 4 维向量、http401/network/timeout/
// dim999 分别模拟 §4.9 各类故障，每次调用记录 host；off 形态不设 GX_EMBEDDING_*、不加载 vec0。
//
// 仅暴露测试复用度高的原语；各用例特有播种/断言写在用例文件里，保持本文件 <300 行。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import type { EmbeddingProvider } from "../../../domain/search/embedding/types.js";
import { deterministicVec4 } from "./m5-ac-m5-3-harness.js";
import {
  createControlledFetch,
  createFailClosedFetch,
  type CloudRule,
  type EmbeddingCall,
} from "./m5-s12-controllable-fetch.js";
import { createDamageHelpers } from "./m5-s12-damage.js";

const JWT_SECRET = "m5-s12-selfheal-secret-atleast-16";
const TOKEN_TTL = 7 * 24 * 60 * 60;
export const S12_OWNER = "s12-owner";

export type { CloudRule, EmbeddingCall };

export interface S12Options {
  label: string;
  /** off=不加载 vec0/不配 cloud；cloud=加载 vec0 + 可控 fetch（默认 controlled）。 */
  mode: "off" | "cloud";
  /** cloud 初始 fetch 故障规则（默认 controlled）。用例可用 setCloudRule 热切换。 */
  rule?: CloudRule;
  /** cloud baseURL（默认 http://127.0.0.1:9/v1）；零外网用例传可识别 host。 */
  baseURL?: string;
  /** cloud 单批超时毫秒（默认 4000；超时故障演练传小值，仅作用于 cloud provider）。 */
  timeoutMs?: number;
  /** true=放一个内容错误的 vec0.dylib 并经 GX_VEC_EXT_PATH 指定（dlsym/dlopen 失败）。 */
  fakeVecExt?: boolean;
  m5Search?: "on" | "shadow" | "off";
  /**
   * fetch 拦截姿态：
   *   "stub"（默认/cloud）：可控 embedding stub，非 /v1/embeddings 请求直接抛错（不出网）；
   *   "failClosed"（off/零外网）：安装 fail-closed 拦截器，任何 fetch 调用都记录并抛错。
   */
  egress?: "stub" | "failClosed";
}

export interface S12World {
  tmpDir: string;
  searchPath: string;
  auditFile: string;
  prisma: PrismaClient;
  app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  token: (userId?: string) => Promise<string>;
  auth: (userId?: string) => Promise<Record<string, string>>;
  http: (url: string, init?: RequestInit) => Promise<Response>;
  /** 热切换 cloud fetch 故障规则（不重启 app）。 */
  setCloudRule: (rule: CloudRule) => void;
  setEnv: (k: string, v: string | undefined) => void;
  /** 造 table+字段+record，syncNav，并按当前形态灌一份派生索引（cloud 用受控向量）。 */
  seedRecord: (p: { primary: string; extra?: string }) => Promise<{
    baseId: string; tableId: string; recordId: string; nodeId: string; primaryField: string;
  }>;
  /** 造 kb+doc，syncNav，灌派生索引。 */
  seedDoc: (word: string) => Promise<{ kbId: string; docId: string; nodeId: string }>;
  /** 关闭现役单例，制造主库+wal+shm 三件，再把主库写成魔数垃圾（真实损坏）。 */
  corruptSearchDbMagic: () => void;
  /** 关闭现役单例后截断主库到 4096 字节（另一种真实损坏形态）。 */
  truncateSearchDb: () => void;
  counts: () => { chunks: number; fts: number; vec: number | null };
  quarantineFiles: () => string[];
  auditLines: () => Array<Record<string, unknown>>;
  embeddingCalls: EmbeddingCall[];
  /**
   * 无操作占位（损坏注入不持连接：按真实崩溃后状态直接落 主库+残留 -wal/-shm 三件）。
   * 保留方法名使演练步骤显式可读：触发自愈后调用，表示不再有额外句柄。
   */
  releaseDamageHandle: () => void;
  modules: () => Promise<{
    searchStore: typeof import("../../../domain/search/searchStore.js");
    recovery: typeof import("../../../domain/search/searchRecovery.js");
    reindex: typeof import("../../../domain/search/reindex.js");
    degrade: typeof import("../../../domain/search/degradeAudit.js");
    queryRuntime: typeof import("../../../domain/search/queryRuntime.js");
  }>;
  cleanup: () => Promise<void>;
}

const ENV_KEYS = [
  "GX_M5_SEARCH", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV", "DATABASE_URL", "GX_DATA_DIR",
  "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV", "GX_RATE_LIMIT", "GX_SEARCH_DB_PATH",
  "GX_EMBEDDING_MODE", "GX_EMBEDDING_API_KEY", "GX_EMBEDDING_BASE_URL", "GX_EMBEDDING_MODEL",
  "GX_EMBEDDING_TIMEOUT_MS", "GX_EMBEDDING_BATCH_SIZE", "GX_VEC_EXT_PATH", "GX_AUTH_STATE_TTL_MS",
] as const;

export async function setupS12(opts: S12Options): Promise<S12World> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  const prevFetch = globalThis.fetch;
  // 同一文件内连续建多个 world 时共享 process.env：先清运维覆盖，避免上一 world 的
  // GX_VEC_EXT_PATH（坏扩展）泄漏到本 world 导致 vec0 加载失败。
  delete process.env.GX_VEC_EXT_PATH;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gx-m5s12-${opts.label}-`));
  const searchPath = path.join(tmpDir, "search.db");
  const auditFile = path.join(tmpDir, ".audit", "audit.logl");
  const envInit: Record<string, string> = {
    DATABASE_URL: `file:${path.join(tmpDir, "s12.db")}`, GX_DATA_DIR: tmpDir,
    GX_AUDIT_DIR: path.join(tmpDir, ".audit"), GX_SEARCH_DB_PATH: searchPath,
    JWT_SECRET, NODE_ENV: "test", GX_RATE_LIMIT: "off", GX_AUTH_STATE_TTL_MS: "0",
    GX_M5_SEARCH: opts.m5Search ?? "on",
  };
  if (opts.fakeVecExt) {
    const fake = path.join(tmpDir, "vec0.dylib");
    fs.writeFileSync(fake, Buffer.from("not-a-real-mach-o-binary-just-bytes-for-dlsym-failure"));
    envInit.GX_VEC_EXT_PATH = fake;
  }
  Object.assign(process.env, envInit);
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  if (opts.mode === "cloud") {
    Object.assign(process.env, {
      GX_EMBEDDING_MODE: "cloud",
      GX_EMBEDDING_BASE_URL: opts.baseURL ?? "http://127.0.0.1:9/v1",
      GX_EMBEDDING_MODEL: "s12-mock", GX_EMBEDDING_API_KEY: "s12-test-key",
      GX_EMBEDDING_TIMEOUT_MS: String(opts.timeoutMs ?? 4000),
    });
  } else {
    ["GX_EMBEDDING_MODE", "GX_EMBEDDING_API_KEY", "GX_EMBEDDING_BASE_URL",
      "GX_EMBEDDING_MODEL", "GX_EMBEDDING_TIMEOUT_MS"].forEach((k) => delete process.env[k]);
  }

  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  await prisma.user.create({ data: {
    id: S12_OWNER, email: `${S12_OWNER}@s12.test`, displayName: S12_OWNER,
    passwordHash: await bcrypt.hash("password123", 10), status: "ACTIVE", workspaceId: "ws_default",
  } });
  await prisma.roleAssignment.create({ data: {
    roleId: "role_owner", subjectType: "user", subjectId: S12_OWNER,
    scopeType: "workspace", createdBy: "seed",
  } });

  // 可控 fetch：故障规则可热切换；任何调用都记 host（零外网断言的事实来源）。
  const controlled = createControlledFetch(opts.rule ?? "controlled");
  const failClosed = createFailClosedFetch();
  const embeddingCalls = opts.egress === "failClosed" ? failClosed.calls : controlled.calls;
  globalThis.fetch = (opts.egress === "failClosed" ? failClosed.fetchImpl : controlled.fetchImpl);

  const { vi } = await import("vitest");
  vi.resetModules();
  const appMod = await import("../../../app.js");
  const app = appMod.createApp().app as unknown as S12World["app"];
  const searchStore = await import("../../../domain/search/searchStore.js");
  const recovery = await import("../../../domain/search/searchRecovery.js");
  const reindex = await import("../../../domain/search/reindex.js");
  const degrade = await import("../../../domain/search/degradeAudit.js");
  const queryRuntime = await import("../../../domain/search/queryRuntime.js");
  const { extractEntity } = await import("../../../domain/search/entityExtract.js");
  const { applyUpsert } = await import("../../../domain/search/indexerDerive.js");
  const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
  const seedCloudProvider = (): EmbeddingProvider => ({
    mode: "cloud", model: "s12-mock", dim: 4, batchSize: 64,
    async embed(texts: readonly string[]) { return texts.map((t) => Float32Array.from(deterministicVec4(t))); },
    async health() { return { ok: true }; },
    async dispose() { return undefined; },
  } as unknown as EmbeddingProvider);

  const token = async (userId = S12_OWNER): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return sign({ userId, tv: 0, iat: now, exp: now + TOKEN_TTL }, JWT_SECRET, "HS256");
  };
  const auth = async (userId?: string): Promise<Record<string, string>> =>
    ({ Authorization: `Bearer ${await token(userId)}`, "Content-Type": "application/json" });
  const http: S12World["http"] = (url, init) => app.request(url, init);

  // 现役库打开口径与服役路径一致：cloud 才尝试 vec0，且透传 GX_VEC_EXT_PATH（坏扩展世界）。
  const openStoreForWorld = () => searchStore.openSearchStore({
    filePath: searchPath,
    appDir: process.cwd(),
    tryLoadVec: opts.mode === "cloud",
    ...(process.env.GX_VEC_EXT_PATH?.trim() ? { vecExtPath: process.env.GX_VEC_EXT_PATH.trim() } : {}),
  });

  let seq = 0;
  const seedRecord: S12World["seedRecord"] = async ({ primary, extra }) => {
    seq += 1;
    const p = `s12r${seq}`;
    const baseId = `${p}_b`, tableId = `${p}_t`, primaryField = `${p}_f0`;
    const recordId = `${p}_r`;
    await prisma.base.create({ data: { id: baseId, name: `${p} 库`, createdBy: S12_OWNER } });
    // 旧写权限链（loadBaseMember）走 legacy members 行：owner 角色才能 POST/PATCH 记录。
    await prisma.member.create({ data: { baseId, userId: S12_OWNER, role: "owner" } });
    await prisma.table.create({ data: { id: tableId, baseId, name: `${p} 表`, primaryFieldId: primaryField, createdBy: S12_OWNER } });
    await prisma.field.create({ data: { id: primaryField, tableId, name: "主字段", type: "singleLineText", order: 0 } });
    const fields: Record<string, string> = { [primaryField]: primary };
    if (extra) {
      const f1 = `${p}_f1`;
      await prisma.field.create({ data: { id: f1, tableId, name: "副字段", type: "longText", order: 1 } });
      fields[f1] = extra;
    }
    await prisma.record.create({ data: {
      id: recordId, tableId, createdBy: S12_OWNER, updatedBy: S12_OWNER, fields: JSON.stringify(fields),
    } });
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    const store = openStoreForWorld();
    try {
      await applyUpsert(store, await extractEntity(prisma, { entityType: "record", entityId: recordId, version: 1n }, 50), {
        workspaceId: "ws_default", mode: opts.mode === "cloud" ? "cloud" : "off",
        provider: opts.mode === "cloud" ? seedCloudProvider() : null,
      });
      store.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally { store.close(); }
    return { baseId, tableId, recordId, nodeId: `nav_table_${tableId}`, primaryField };
  };

  const seedDoc: S12World["seedDoc"] = async (word) => {
    seq += 1;
    const p = `s12d${seq}`;
    const kbId = `${p}_kb`, docId = `${p}_doc`;
    await prisma.knowledgeBase.create({ data: { id: kbId, name: `${p} 知识库`, createdBy: S12_OWNER } });
    // 旧 kb 写权限链（requireKb/requireDocAccess）走 kb_members。
    await prisma.kbMember.create({ data: { kbId, userId: S12_OWNER, role: "owner" } });
    await prisma.kbDoc.create({ data: {
      id: docId, kbId, kind: "doc", title: `${p} 标题`, content: `# ${p}\n\n${word}`, searchText: word,
      createdBy: S12_OWNER, updatedBy: S12_OWNER,
    } });
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    const store = openStoreForWorld();
    try {
      await applyUpsert(store, await extractEntity(prisma, { entityType: "doc", entityId: docId, version: 0n }, 50), {
        workspaceId: "ws_default", mode: opts.mode === "cloud" ? "cloud" : "off",
        provider: opts.mode === "cloud" ? seedCloudProvider() : null,
      });
      store.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally { store.close(); }
    return { kbId, docId, nodeId: `nav_doc_${docId}` };
  };

  // 损坏注入（复刻进程崩溃后现场）实现见 m5-s12-damage.ts。
  const damage = createDamageHelpers({ searchStore, searchPath, tmpDir });
  const corruptSearchDbMagic: S12World["corruptSearchDbMagic"] = damage.corruptMagic;
  const truncateSearchDb: S12World["truncateSearchDb"] = damage.truncate4096;
  const releaseDamageHandle: S12World["releaseDamageHandle"] = damage.releaseHandle;

  const counts: S12World["counts"] = () => {
    const s = openStoreForWorld();
    try {
      const one = (sql: string): number => (s.db.prepare(sql).get() as { c: number }).c;
      const hasVec = s.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'").get() !== undefined;
      return {
        chunks: one("SELECT COUNT(*) AS c FROM chunks"), fts: one("SELECT COUNT(*) AS c FROM fts_chunks"),
        vec: opts.mode === "cloud" && hasVec ? one("SELECT COUNT(*) AS c FROM vec_chunks") : null,
      };
    } finally { s.close(); }
  };
  const quarantineFiles = (): string[] =>
    fs.readdirSync(tmpDir).filter((f) => f.includes(".corrupt-")).map((f) => path.join(tmpDir, f)).sort();
  const auditLines = (): Array<Record<string, unknown>> => {
    if (!fs.existsSync(auditFile)) return [];
    return fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const modules = () => Promise.resolve({ searchStore, recovery, reindex, degrade, queryRuntime });
  const cleanup = async (): Promise<void> => {
    searchStore.closeSearchStore();
    await prisma.$disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    globalThis.fetch = prevFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  return {
    tmpDir, searchPath, auditFile, prisma, app, token, auth, http,
    setCloudRule: (r) => { controlled.setRule(r); },
    setEnv: (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; },
    seedRecord, seedDoc, corruptSearchDbMagic, truncateSearchDb, releaseDamageHandle,
    counts, quarantineFiles,
    auditLines, embeddingCalls, modules, cleanup,
  };
}

/** 便捷：owner 鉴权 GET /api/v1/search。 */
export async function searchOnce(
  w: S12World, q: string, extra = "",
): Promise<{ status: number; body: any }> {
  const res = await w.http(`/api/v1/search?q=${encodeURIComponent(q)}${extra}`, { headers: { Authorization: `Bearer ${await w.token()}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

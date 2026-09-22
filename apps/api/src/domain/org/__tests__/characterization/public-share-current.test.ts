// M2/S0 特征测试（三）：匿名公开外链不依赖用户（真迁移临时库 + 真 public 路由）。
//
// 锁计划 §5-D.5 / 总监裁决 1：GET /api/public/s/:token 是匿名持票即准入，不绑定任何
// 用户；停用（M2 后）乃至删除其创建者，都不得影响该外链可用性。
//
// 为保证本文件在 S1（加 status 列）/S2（getUserId 查库）后依旧全绿，采用比"停用"更强、
// 且与 M2 前后都成立的结构性证明：
//   1) 不带任何 Authorization -> 200；带某个登录用户的合法 Bearer -> 同样 200（授权头被忽略）；
//   2) 在公开访问期间给底层 client 的 user 委托下探针，断言公开路由【零次】访问 users 表；
//   3) 直接物理删除分享创建者用户 -> /s/:token 仍 200（kb_docs.createdBy 仅为字符串、无 FK，
//      匿名通道不 join users；则 M2 的 DISABLED 只是 users 行内状态，更不可能影响它）；
//   4) 失效 token 仍 404（现状不被 M2 改变）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import { PrismaClient } from "@prisma/client";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me-in-production";
const TTL = 7 * 24 * 60 * 60;

let tmpDir: string;
let realClient: PrismaClient;
let prisma: PrismaClient;
let pub: typeof import("../../../../routes/public.js")["pub"];
let docId: string;
const TOKEN = "m2-anon-share-token";

const USER_METHODS = ["findFirst", "findMany", "findUnique", "findUniqueOrThrow", "count", "aggregate"] as const;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-public-cur-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.JWT_SECRET = JWT_SECRET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  realClient = new PrismaClient();
  globalThis.__gx_prisma = realClient;
  prisma = realClient;
  const mod = await import("../../../../routes/public.js");
  pub = mod.pub;

  await prisma.user.create({
    data: { id: "u_creator", email: "creator@example.com", displayName: "C", passwordHash: "x" },
  });
  const kb = await prisma.knowledgeBase.create({
    // 开库级「允许分享」总闸：访问侧两级开关要求【库级 && 文档级】都为开才放行
    // （shareLinkLookup.resolveShareTarget -> readShareEnabled("kb", doc.kbId)）。
    // 本文件验证的是「匿名持票即准入、与用户解耦」，不是总闸行为；不补这一位会被总闸
    // 先一步拦成 403「该知识库已关闭分享」，四条断言都落在错误的拒绝层上。
    data: { id: "kb1", name: "kb", createdBy: "u_creator", shareEnabled: 1 },
  });
  const doc = await prisma.kbDoc.create({
    data: {
      id: "doc_root", kbId: kb.id, kind: "doc", title: "公开文档标题", content: "正文",
      createdBy: "u_creator", updatedBy: "u_creator",
      shareEnabled: true, shareToken: TOKEN, shareRole: "viewer", shareIncludeChildren: false,
    },
  });
  docId = doc.id;
}, 120000);

afterAll(async () => {
  await realClient?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getShare(token: string, headers: Record<string, string> = {}) {
  const res = await pub.request(`/s/${token}`, { method: "GET", headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** 在底层 user 委托上安装探针，返回探针期内对 users 表的调用名清单，结束后还原。 */
async function withUserProbe<T>(fn: () => Promise<T>): Promise<{ result: T; userCalls: string[] }> {
  const userCalls: string[] = [];
  const delegate = realClient.user as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const m of USER_METHODS) {
    saved.set(m, delegate[m]);
    delegate[m] = (...args: unknown[]) => {
      userCalls.push(m);
      return (saved.get(m) as (...a: unknown[]) => unknown).apply(delegate, args);
    };
  }
  try {
    const result = await fn();
    return { result, userCalls };
  } finally {
    for (const m of USER_METHODS) delegate[m] = saved.get(m);
  }
}

describe("GET /api/public/s/:token 匿名通道与用户解耦", () => {
  it("无 Authorization 头 -> 200，返回分享文档", async () => {
    const { status, body } = await getShare(TOKEN);
    expect(status).toBe(200);
    expect((body as { doc: { id: string; title: string } }).doc.id).toBe(docId);
    expect((body as { doc: { title: string } }).doc.title).toBe("公开文档标题");
    expect((body as { canEdit: boolean }).canEdit).toBe(false);
  });

  it("携带某登录用户合法 Bearer -> 仍 200（授权头被忽略，匿名为准）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await sign({ userId: "u_creator", iat: now, exp: now + TTL }, JWT_SECRET, "HS256");
    const { status } = await getShare(TOKEN, { Authorization: `Bearer ${jwt}` });
    expect(status).toBe(200);
  });

  it("公开访问期间零次查询 users 表", async () => {
    const { result, userCalls } = await withUserProbe(() => getShare(TOKEN).then((r) => r.status));
    expect(result).toBe(200);
    expect(userCalls).toEqual([]);
  });

  it("物理删除分享创建者后，外链仍 200（停用是更弱的用户行内状态，M2 后同样不影响）", async () => {
    await prisma.user.delete({ where: { id: "u_creator" } });
    const { status, body } = await getShare(TOKEN);
    expect(status).toBe(200);
    expect((body as { doc: { id: string } }).doc.id).toBe(docId);
  });

  it("失效 token -> 404（现状语义不变）", async () => {
    const { status } = await getShare("no-such-token");
    expect(status).toBe(404);
  });
});

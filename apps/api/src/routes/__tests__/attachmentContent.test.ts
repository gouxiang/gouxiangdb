// 附件下载（GET /:id/content）与删除（DELETE /:id）契约测试。
// 上传与落盘原语见 attachments.test.ts（共用 _attachmentHarness.ts 夹具）。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  OWNER_ID,
  OUTSIDER_ID,
  setupAttachmentHarness,
  type AttachmentHarness,
} from "./_attachmentHarness.js";

let currentUserId: string | null = OWNER_ID;
// 只替换 getUserId，其余导出保留真身（与 attachments.test.ts 同款）。
vi.mock("../../auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../auth.js");
  return { ...actual, getUserId: () => Promise.resolve(currentUserId) };
});

let h: AttachmentHarness;

beforeAll(async () => {
  h = await setupAttachmentHarness("gx-attachment-io-");
}, 120_000);

afterAll(async () => {
  await h.teardown();
});

const json = async (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>;

interface Dto { id: string; name: string; mime: string; size: number; url: string }

async function uploadOne(
  baseId: string,
  name = "dl.txt",
  type = "text/plain",
  content: string | Buffer = "download me",
): Promise<{ dto: Dto; abs: string }> {
  const res = await h.upload([{ name, type, content }], { baseId });
  expect(res.status).toBe(201);
  const dto = (await json(res)).files[0] as Dto;
  const row = await h.prisma.attachment.findUniqueOrThrow({ where: { id: dto.id } });
  return { dto, abs: h.findStoredFile(row.sha256)! };
}

// ============ 1) GET /:id/content ============

describe("GET /api/attachments/:id/content", () => {
  it("未登录 → 401；无权限用户 → 403", async () => {
    const baseId = await h.makeBase("B-dl-perm");
    const { dto } = await uploadOne(baseId);

    currentUserId = null;
    expect((await h.app.request(dto.url)).status).toBe(401);

    currentUserId = OUTSIDER_ID;
    expect((await h.app.request(dto.url)).status).toBe(403);

    currentUserId = OWNER_ID;
  });

  it("有权限 → 200，Content-Type 与 Content-Disposition 正确，内容一致", async () => {
    const baseId = await h.makeBase("B-dl-ok");
    const { dto } = await uploadOne(baseId, "报表.txt", "text/plain", "中文内容");
    const res = await h.app.request(dto.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(await res.text()).toBe("中文内容");
  });

  it("SVG 强制下载 + 沙箱 CSP（防内联脚本执行）", async () => {
    const baseId = await h.makeBase("B-svg");
    const { dto } = await uploadOne(baseId, "x.svg", "image/svg+xml", "<svg onload='alert(1)'/>");
    const res = await h.app.request(dto.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("不存在的 id → 404；已软删 → 404", async () => {
    const baseId = await h.makeBase("B-dl-404");
    const { dto } = await uploadOne(baseId);
    expect((await h.app.request("/api/attachments/nope/content")).status).toBe(404);
    await h.prisma.attachment.update({ where: { id: dto.id }, data: { deletedAt: new Date() } });
    expect((await h.app.request(dto.url)).status).toBe(404);
  });

  it("库里有记录但磁盘文件丢失 → 404（不 500）", async () => {
    const baseId = await h.makeBase("B-dl-missing");
    const { dto, abs } = await uploadOne(baseId);
    fs.rmSync(abs, { force: true });
    expect((await h.app.request(dto.url)).status).toBe(404);
  });
});

// ============ 2) DELETE /:id ============

describe("DELETE /api/attachments/:id", () => {
  it("仍被记录引用 → 409，物理文件必须还在（绝不删掉还在展示的文件）", async () => {
    const baseId = await h.makeBase("B-del-inuse");
    const { dto, abs } = await uploadOne(baseId, "d.txt", "text/plain", "to delete");
    await h.makeRecord(baseId, JSON.stringify({
      f1: [{ id: dto.id, name: "d.txt", size: 9, mime: "text/plain", url: dto.url }],
    }));

    const res = await h.app.request(`/api/attachments/${dto.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain("仍被记录引用");
    expect(fs.existsSync(abs)).toBe(true);
    expect((await h.prisma.attachment.findUniqueOrThrow({ where: { id: dto.id } })).deletedAt).toBeNull();
    // 引用未解除前，下载仍要正常
    expect((await h.app.request(dto.url)).status).toBe(200);

    const events = h.readAudit().filter((e) => e.event === "attachment_delete");
    expect(events[events.length - 1].status).toBe(409);
  });

  it("无人引用 → 软删落 deletedAt、物理文件被删、再下载 404", async () => {
    const baseId = await h.makeBase("B-del-ok");
    const { dto, abs } = await uploadOne(baseId, "d.txt", "text/plain", "orphan");
    const res = await h.app.request(`/api/attachments/${dto.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
    expect((await h.prisma.attachment.findUniqueOrThrow({ where: { id: dto.id } })).deletedAt).not.toBeNull();
    expect(fs.existsSync(abs)).toBe(false);
    expect((await h.app.request(dto.url)).status).toBe(404);

    const events = h.readAudit().filter((e) => e.event === "attachment_delete" && e.status === 200);
    expect(events.length).toBeGreaterThan(0);
  });

  it("同一内容被另一行共用 → 先删者只软删，文件保留；再删另一行才释放文件", async () => {
    const baseA = await h.makeBase("B-share-a");
    const { dto, abs } = await uploadOne(baseA, "d.txt", "text/plain", "shared content");
    const row = await h.prisma.attachment.findUniqueOrThrow({ where: { id: dto.id } });
    const otherId = "att-other";
    await h.prisma.attachment.create({
      data: {
        id: otherId, baseId: baseA, name: "shared.txt", mime: "text/plain",
        size: row.size, sha256: row.sha256, storagePath: row.storagePath, uploaderId: OWNER_ID,
      },
    });

    expect((await h.app.request(`/api/attachments/${dto.id}`, { method: "DELETE" })).status).toBe(200);
    expect(fs.existsSync(abs)).toBe(true);

    expect((await h.app.request(`/api/attachments/${otherId}`, { method: "DELETE" })).status).toBe(200);
    expect(fs.existsSync(abs)).toBe(false);
  });

  it("无编辑权 → 403；未登录 → 401；不存在 → 404", async () => {
    const baseId = await h.makeBase("B-del-perm");
    const { dto } = await uploadOne(baseId, "d.txt", "text/plain", "perm");

    currentUserId = OUTSIDER_ID;
    expect((await h.app.request(`/api/attachments/${dto.id}`, { method: "DELETE" })).status).toBe(403);
    currentUserId = null;
    expect((await h.app.request(`/api/attachments/${dto.id}`, { method: "DELETE" })).status).toBe(401);
    currentUserId = OWNER_ID;
    expect((await h.app.request("/api/attachments/nope", { method: "DELETE" })).status).toBe(404);
  });
});

// 附件上传（POST /api/attachments）契约测试 + 落盘原语纯函数测试。
// 下载与删除见 attachmentContent.test.ts（共用 _attachmentHarness.ts 夹具）。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  OWNER_ID,
  OUTSIDER_ID,
  setupAttachmentHarness,
  type AttachmentHarness,
} from "./_attachmentHarness.js";

let currentUserId: string | null = OWNER_ID;
// 只替换 getUserId，其余导出（auth 路由实例等）保留真身，否则 createApp 装配会缺件。
vi.mock("../../auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../auth.js");
  return { ...actual, getUserId: () => Promise.resolve(currentUserId) };
});

let h: AttachmentHarness;

beforeAll(async () => {
  h = await setupAttachmentHarness();
}, 120_000);

afterAll(async () => {
  await h.teardown();
});

const json = async (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>;

/** 统计 uploadRoot 下已落盘的文件总数（去重/是否新增物理文件用）。 */
function countStoredFiles(): number {
  const root = path.join(h.uploadRoot, "attachments");
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(root)) {
    for (const s of fs.readdirSync(path.join(root, d))) {
      n += fs.readdirSync(path.join(root, d, s)).length;
    }
  }
  return n;
}

// ============ 1) 落盘原语纯函数 ============

describe("附件落盘原语", () => {
  it("白名单内扩展名解析出 mime；白名单外返回 null", async () => {
    const m = await import("../../domain/attachmentStore.js");
    expect(m.resolveFileType("a.PNG", "image/png")).toEqual({ ext: "png", mime: "image/png" });
    // 浏览器不给 type（空串）→ 取该扩展名缺省 mime
    expect(m.resolveFileType("a.pdf", "")).toEqual({ ext: "pdf", mime: "application/pdf" });
    expect(m.resolveFileType("a.docx", "application/octet-stream")?.ext).toBe("docx");
    // 扩展名与 mime 不匹配 → 拒绝
    expect(m.resolveFileType("a.png", "text/html")).toBeNull();
    expect(m.resolveFileType("evil.exe", "application/x-msdownload")).toBeNull();
    expect(m.resolveFileType("noext", "text/plain")).toBeNull();
    expect(m.resolveFileType("a.sh", "text/x-sh")).toBeNull();
  });

  it("storagePath 形如 attachments/<yyyy>/<mm>/<sha256>.<ext>；越界路径一律拒绝解析", async () => {
    const m = await import("../../domain/attachmentStore.js");
    const p = m.buildStoragePath("a".repeat(64), "png", new Date(Date.UTC(2026, 9, 3)));
    expect(p).toBe("attachments/2026/10/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png");
    expect(m.resolveStoredFile(p)).toBe(path.join(h.uploadRoot, p));
    expect(m.resolveStoredFile("attachments/2026/10/../../../../etc/passwd")).toBeNull();
    expect(m.resolveStoredFile("/etc/passwd")).toBeNull();
    expect(m.resolveStoredFile("attachments/2026/10/not-a-sha.png")).toBeNull();
  });

  it("Content-Disposition 同时给 ASCII 兜底与 RFC5987 中文名", async () => {
    const m = await import("../../domain/attachmentStore.js");
    expect(m.contentDisposition("inline", "报表.pdf")).toBe(
      "inline; filename=\"__.pdf\"; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.pdf",
    );
  });
});

// ============ 2) POST /api/attachments ============

describe("POST /api/attachments", () => {
  it("上传一个小文件 → 201、DTO 形状正确、文件真实落盘", async () => {
    const baseId = await h.makeBase("B-up");
    const res = await h.upload(
      [{ name: "note.txt", type: "text/plain", content: "hello attachment" }],
      { baseId },
    );
    expect(res.status).toBe(201);
    const { files } = await json(res);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: "note.txt",
      size: Buffer.byteLength("hello attachment"),
      mime: "text/plain",
      url: `/api/attachments/${files[0].id}/content`,
    });

    const row = await h.prisma.attachment.findUniqueOrThrow({ where: { id: files[0].id } });
    expect(row.baseId).toBe(baseId);
    expect(row.sha256).toBe(createHash("sha256").update("hello attachment").digest("hex"));
    // 真落盘：磁盘上能按 sha256 找到文件，且内容与上传一致
    const abs = h.findStoredFile(row.sha256);
    expect(abs).toBeTruthy();
    expect(fs.readFileSync(abs!, "utf8")).toBe("hello attachment");
  });

  it("一次传多个文件 → 全部成功且各落一行", async () => {
    const baseId = await h.makeBase("B-multi");
    const res = await h.upload([
      { name: "a.txt", type: "text/plain", content: "aaa" },
      { name: "b.png", type: "image/png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]) },
      { name: "c.pdf", type: "application/pdf", content: "%PDF-1.4" },
    ], { baseId });
    expect(res.status).toBe(201);
    const { files } = await json(res);
    expect(files.map((f: any) => f.name)).toEqual(["a.txt", "b.png", "c.pdf"]);
    expect(files.map((f: any) => f.mime)).toEqual(["text/plain", "image/png", "application/pdf"]);
    expect(await h.prisma.attachment.count({ where: { baseId } })).toBe(3);
  });

  it("超过单次上限（21 个）→ 400 且不落任何行", async () => {
    const baseId = await h.makeBase("B-count");
    const many = Array.from({ length: 21 }, (_, i) => ({
      name: `f${i}.txt`, type: "text/plain", content: `x${i}`,
    }));
    const res = await h.upload(many, { baseId });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain("单次最多上传 20 个文件");
    expect(await h.prisma.attachment.count({ where: { baseId } })).toBe(0);
  });

  it("单文件超过 2MB 上限 → 400 且错误信息含文件名与上限", async () => {
    const baseId = await h.makeBase("B-big");
    const res = await h.upload(
      [{ name: "big.zip", type: "application/zip", content: Buffer.alloc(2 * 1024 * 1024 + 1, 7) }],
      { baseId },
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("文件 big.zip 超过 2MB 上限");
    expect(await h.prisma.attachment.count({ where: { baseId } })).toBe(0);
  });

  it("白名单外格式（.exe）→ 400 且错误信息列明白名单", async () => {
    const baseId = await h.makeBase("B-ext");
    const res = await h.upload(
      [{ name: "setup.exe", type: "application/octet-stream", content: "MZ" }],
      { baseId },
    );
    expect(res.status).toBe(400);
    const { error } = await json(res);
    expect(error).toContain("不支持的文件格式：setup.exe");
    expect(error).toContain("仅支持");
    expect(error).toContain("pdf");
    // 扩展名合法但 mime 明显不符（.png 报 text/html）同样拒绝
    expect((await h.upload(
      [{ name: "x.png", type: "text/html", content: "<html>" }], { baseId },
    )).status).toBe(400);
    expect(await h.prisma.attachment.count({ where: { baseId } })).toBe(0);
  });

  it("缺 baseId → 400；无 file 字段 → 400", async () => {
    expect((await h.upload([{ name: "a.txt", type: "text/plain", content: "x" }])).status).toBe(400);
    const baseId = await h.makeBase("B-nofile");
    const fd = new FormData();
    fd.append("baseId", baseId);
    const res = await h.app.request("/api/attachments", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain("file");
  });

  it("同库重复上传同一内容 → 复用同一条记录，磁盘不新增文件", async () => {
    const baseId = await h.makeBase("B-dedupe");
    const first = await json(await h.upload(
      [{ name: "same.txt", type: "text/plain", content: "dup" }], { baseId },
    ));
    const before = countStoredFiles();
    const second = await json(await h.upload(
      [{ name: "same.txt", type: "text/plain", content: "dup" }], { baseId },
    ));
    expect(second.files[0].id).toBe(first.files[0].id);
    expect(await h.prisma.attachment.count({ where: { baseId } })).toBe(1);
    expect(countStoredFiles()).toBe(before);
  });

  it("无编辑权（外部用户）→ 403；未登录 → 401", async () => {
    const baseId = await h.makeBase("B-perm");
    currentUserId = OUTSIDER_ID;
    expect((await h.upload(
      [{ name: "a.txt", type: "text/plain", content: "x" }], { baseId },
    )).status).toBe(403);

    currentUserId = null;
    expect((await h.upload(
      [{ name: "a.txt", type: "text/plain", content: "x" }], { baseId },
    )).status).toBe(401);

    currentUserId = OWNER_ID;
    expect(await h.prisma.attachment.count({ where: { baseId } })).toBe(0);
  });

  it("上传落 attachment_upload 审计（detail 只有元数据，不含文件内容）", async () => {
    const baseId = await h.makeBase("B-audit");
    const before = h.readAudit().filter((e) => e.event === "attachment_upload").length;
    const res = await h.upload(
      [{ name: "audit.txt", type: "text/plain", content: "audited" }], { baseId },
    );
    expect(res.status).toBe(201);
    const events = h.readAudit().filter((e) => e.event === "attachment_upload");
    expect(events.length).toBe(before + 1);
    const last = events[events.length - 1];
    expect(last.status).toBe(200);
    expect(last.detail).toMatchObject({ id: (await json(res)).files[0].id, bytes: 7, mime: "text/plain" });
    expect(JSON.stringify(last.detail)).not.toContain("audited");
  });

  it("请求体分档：>JSON 档(256KB) 的包不被 413（证明走的是附件档而非 JSON 档）", async () => {
    const baseId = await h.makeBase("B-gate");
    const res = await h.upload(
      [{ name: "big.txt", type: "text/plain", content: Buffer.alloc(600 * 1024, 65) }],
      { baseId },
      h.gatedApp,
    );
    expect(res.status).toBe(201);
    expect((await json(res)).files).toHaveLength(1);
  });

  it("请求体分档：超过附件档(2MB) 的包被中间件挡在 413（路由根本不会被执行）", async () => {
    const baseId = await h.makeBase("B-gate-413");
    const res = await h.upload(
      [{ name: "huge.zip", type: "application/zip", content: Buffer.alloc(2 * 1024 * 1024 + 1, 7) }],
      { baseId },
      h.gatedApp,
    );
    expect(res.status).toBe(413);
    expect((await json(res)).code).toBe("PAYLOAD_TOO_LARGE");
    expect(await h.prisma.attachment.count({ where: { baseId } })).toBe(0);
  });

  it("真 app（createApp）已挂上 /api/attachments：不带 multipart 是 400 而非 404", async () => {
    const { createApp } = await import("../../app.js");
    const full = createApp().app;
    const res = await full.request("/api/attachments", { method: "POST" });
    // 404 = 没挂上；400 = 路由命中但请求体不合 multipart
    expect(res.status).toBe(400);
  });
});

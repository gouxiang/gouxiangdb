// 数据库名 / 知识库名【全局唯一 + trim】契约测试（真 app HTTP + 真迁移临时库）。
// 覆盖：建库/建 KB 重名 409（含 trim）、纯空格 400 不落库、软删后名字可复用；
// 改名撞名 409 原名不变、改成自己现名 200、不带 name 只改 icon 200、纯空格 400。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;

beforeAll(async () => {
  h = await setupHarness("gx-library-name-unique-", "entities");
}, 120000);

afterAll(async () => {
  await h.teardown();
});

const json = async (res: Response): Promise<Record<string, any>> =>
  res.json() as Promise<Record<string, any>>;

async function liveBaseCount(): Promise<number> {
  return h.prisma.base.count({ where: { deletedAt: null } });
}
async function liveKbCount(): Promise<number> {
  return h.prisma.knowledgeBase.count({ where: { deletedAt: null } });
}

describe("建数据库：全局名字唯一 + trim", () => {
  it("重名 → 409，不产生新库", async () => {
    const first = await h.request("POST", "/bases", { name: "构想库" });
    expect(first.status).toBe(201);
    expect((await json(first)).base.name).toBe("构想库");

    const dup = await h.request("POST", "/bases", { name: "构想库" });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("数据库名「构想库」已存在");
  });

  it("trim 后同名即重名；落库为 trim 后值", async () => {
    const ok = await h.request("POST", "/bases", { name: "  空间A  " });
    expect(ok.status).toBe(201);
    expect((await json(ok)).base.name).toBe("空间A");
    const dup = await h.request("POST", "/bases", { name: "空间A" });
    expect(dup.status).toBe(409);
  });

  it("纯空格名 → 400，不落库", async () => {
    const before = await liveBaseCount();
    const res = await h.request("POST", "/bases", { name: "   " });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("数据库名不能为空");
    expect(await liveBaseCount()).toBe(before);
  });

  it("软删的库名可复用", async () => {
    const created = await json(await h.request("POST", "/bases", { name: "临时库" }));
    expect((await h.request("DELETE", `/bases/${created.base.id}`)).status).toBe(200);
    const again = await h.request("POST", "/bases", { name: "临时库" });
    expect(again.status).toBe(201);
  });
});

describe("数据库改名：全局查重排除自己 + trim", () => {
  it("改名撞上另一库 → 409，原名保持不变", async () => {
    const a = await json(await h.request("POST", "/bases", { name: "库A" }));
    const b = await json(await h.request("POST", "/bases", { name: "库B" }));
    const res = await h.request("PATCH", `/bases/${b.base.id}`, { name: "库A" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("数据库名「库A」已存在");
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: b.base.id } })).name).toBe("库B");
  });

  it("改成自己现在的名字 → 200", async () => {
    const a = await json(await h.request("POST", "/bases", { name: "自有名" }));
    const res = await h.request("PATCH", `/bases/${a.base.id}`, { name: "自有名" });
    expect(res.status).toBe(200);
    expect((await json(res)).base.name).toBe("自有名");
  });

  it("不带 name 只改 icon/iconColor → 200，不被查重误伤", async () => {
    const a = await json(await h.request("POST", "/bases", { name: "仅图标库" }));
    const res = await h.request("PATCH", `/bases/${a.base.id}`, { icon: "star", iconColor: "#123456" });
    expect(res.status).toBe(200);
    expect((await json(res)).base).toMatchObject({ name: "仅图标库", icon: "star" });
  });

  it("改名传纯空格 → 400，原名不变", async () => {
    const a = await json(await h.request("POST", "/bases", { name: "原名库X" }));
    const res = await h.request("PATCH", `/bases/${a.base.id}`, { name: "  " });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("数据库名不能为空");
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: a.base.id } })).name).toBe("原名库X");
  });
});

describe("建知识库：全局名字唯一 + trim", () => {
  it("重名 → 409，不产生新 KB", async () => {
    const first = await h.request("POST", "/kb", { name: "团队百科" });
    expect(first.status).toBe(201);
    const dup = await h.request("POST", "/kb", { name: "团队百科" });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("知识库名「团队百科」已存在");
  });

  it("trim 后同名即重名", async () => {
    const ok = await h.request("POST", "/kb", { name: " 百科B " });
    expect(ok.status).toBe(201);
    expect((await json(ok)).knowledgeBase.name).toBe("百科B");
    const dup = await h.request("POST", "/kb", { name: "百科B" });
    expect(dup.status).toBe(409);
  });

  it("纯空格名 → 400，不落库", async () => {
    const before = await liveKbCount();
    const res = await h.request("POST", "/kb", { name: "  " });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("知识库名不能为空");
    expect(await liveKbCount()).toBe(before);
  });
});

describe("知识库改名：全局查重排除自己 + trim", () => {
  it("改名撞上另一 KB → 409，原名保持不变", async () => {
    const a = await json(await h.request("POST", "/kb", { name: "K-A" }));
    const b = await json(await h.request("POST", "/kb", { name: "K-B" }));
    const res = await h.request("PATCH", `/kb/${b.knowledgeBase.id}`, { name: "K-A" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("知识库名「K-A」已存在");
    expect((await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: b.knowledgeBase.id } })).name).toBe("K-B");
  });

  it("改成自己现名 → 200；trim 后写库", async () => {
    const a = await json(await h.request("POST", "/kb", { name: "自有KB" }));
    const res = await h.request("PATCH", `/kb/${a.knowledgeBase.id}`, { name: " 自有KB " });
    expect(res.status).toBe(200);
    expect((await json(res)).knowledgeBase.name).toBe("自有KB");
  });
});

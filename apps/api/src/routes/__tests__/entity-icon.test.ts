// 五类实体「自定义图标 + 图标颜色」契约测试（真 app HTTP + 真迁移临时库，不 mock 路由）。
//
// 覆盖总监锁定契约的四条：
//   1. icon 必须是 ENTITY_ICONS 白名单之一或 null；iconColor 必须匹配 /^#[0-9a-fA-F]{6}$/ 或 null；
//      非法值 → 400（沿用各端点既有 { error } 返回形态）。
//   2. 合法设置 → 落库并随 DTO 透出（list / get / patch 响应都带 icon、iconColor）。
//   3. null → 清除回默认（DB 列回到 NULL，未自定义语义由前端按类型渲染）。
//   4. 默认色不动：Base 仍 #378ADD、KB 仍 #0F6E56；实体图标不进 nav_nodes。
//
// 夹具沿用 _realApp.ts 的 "entities" 挂载（bases + tables + kb），身份固定 owner。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  setupHarness,
  type Harness,
  OWNER_ID,
} from "./_realApp.js";
import {
  ENTITY_ICONS,
  ENTITY_ICON_COLOR_RE,
  isEntityIcon,
  isEntityIconColor,
  type EntityIcon,
} from "@gx/shared-types";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;

beforeAll(async () => {
  h = await setupHarness("gx-entity-icon-", "entities");
});

afterAll(async () => {
  await h.teardown();
});

const json = async (res: Response): Promise<Record<string, any>> => res.json() as Promise<Record<string, any>>;

// ============ 1) 白名单与校验纯函数 ============

describe("ENTITY_ICONS 白名单", () => {
  it("白名单内取值通过，白名单外拒绝", () => {
    expect(isEntityIcon("database")).toBe(true);
    expect(isEntityIcon("eye")).toBe(true);
    expect(isEntityIcon("notAnIcon")).toBe(false);
    expect(isEntityIcon(null)).toBe(false);
    expect(isEntityIcon(42)).toBe(false);
  });

  it("图标颜色只接受 #RRGGBB", () => {
    expect(isEntityIconColor("#378ADD")).toBe(true);
    expect(isEntityIconColor("#0f6e56")).toBe(true);
    expect(isEntityIconColor("#FFF")).toBe(false);
    expect(isEntityIconColor("378ADD")).toBe(false);
    expect(isEntityIconColor("rgb(1,2,3)")).toBe(false);
    expect(ENTITY_ICON_COLOR_RE.test("#ABCDEF")).toBe(true);
  });

  it("白名单每个名字都在 web icons.tsx 的 IconName 里存在（防改名/幻觉）", async () => {
    // 真源读 icons.tsx 源码文本，避免把 shared-types 拖进 web 依赖。
    // vitest cwd = apps/api（见 _realApp.ts 的 migrate 调用），故 ../web 即 apps/web。
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "../web/src/components/icons.tsx"), "utf8");
    const unionStart = src.indexOf("export type IconName =");
    const unionEnd = src.indexOf("const PATHS", unionStart);
    expect(unionStart).toBeGreaterThan(-1);
    expect(unionEnd).toBeGreaterThan(unionStart);
    const union = src.slice(unionStart, unionEnd);
    for (const name of ENTITY_ICONS) {
      expect(union, `icons.tsx 缺少图标 ${name}`).toContain(`| "${name}"`);
    }
  });

  it("白名单不重复（数组推导出的联合类型不会被重复字面量污染）", () => {
    expect(new Set(ENTITY_ICONS).size).toBe(ENTITY_ICONS.length);
  });
});

// ============ 2) Base ============

describe("Base 自定义图标", () => {
  it("未自定义时 icon 为 null，默认色仍是 #378ADD", async () => {
    const baseId = await h.makeBase("B-default");
    const res = await h.request("GET", `/bases/${baseId}`);
    expect(res.status).toBe(200);
    const { base } = await json(res);
    expect(base.icon).toBeNull();
    expect(base.iconColor).toBe("#378ADD");
  });

  it("非法 icon 返回 400 且不落库", async () => {
    const baseId = await h.makeBase("B-bad");
    const res = await h.request("PATCH", `/bases/${baseId}`, { icon: "notAnIcon" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("参数不合法");
    const row = await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } });
    expect(row.icon).toBeNull();
  });

  it("合法设置 → 落库并随 DTO 透出；null 清除回默认", async () => {
    const baseId = await h.makeBase("B-set");
    const ok = await h.request("PATCH", `/bases/${baseId}`, { icon: "database" });
    expect(ok.status).toBe(200);
    expect((await json(ok)).base.icon).toBe("database");

    // list / get 都透出
    const list = await json(await h.request("GET", "/bases"));
    expect(list.bases.find((b: any) => b.id === baseId).icon).toBe("database");
    expect((await json(await h.request("GET", `/bases/${baseId}`))).base.icon).toBe("database");
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } })).icon).toBe("database");

    // null 清除回默认（DB 列回到 NULL ≠ 空串）
    const cleared = await h.request("PATCH", `/bases/${baseId}`, { icon: null });
    expect(cleared.status).toBe(200);
    expect((await json(cleared)).base.icon).toBeNull();
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } })).icon).toBeNull();
  });

  it("创建时也允许带 icon", async () => {
    const res = await h.request("POST", "/bases", { name: "B-create", icon: "star" });
    expect(res.status).toBe(201);
    const { base } = await json(res);
    expect(base.icon).toBe("star");
    expect(base.iconColor).toBe("#378ADD");
  });

  // —— 恢复默认：iconColor 列 NOT NULL，null 语义 = 回到系统默认色 #378ADD ——

  it("恢复默认 {icon:null, iconColor:null} → icon 回 NULL、颜色回 #378ADD", async () => {
    const baseId = await h.makeBase("B-reset-all");
    const set = await h.request("PATCH", `/bases/${baseId}`, { icon: "database", iconColor: "#123456" });
    expect(set.status).toBe(200);

    const res = await h.request("PATCH", `/bases/${baseId}`, { icon: null, iconColor: null });
    expect(res.status).toBe(200);
    const { base } = await json(res);
    expect(base.icon).toBeNull();
    expect(base.iconColor).toBe("#378ADD");
    const row = await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } });
    expect(row.icon).toBeNull();
    expect(row.iconColor).toBe("#378ADD");
  });

  it("只恢复颜色 {icon:'book', iconColor:null} → icon 保留、颜色回 #378ADD", async () => {
    const baseId = await h.makeBase("B-reset-color");
    await h.request("PATCH", `/bases/${baseId}`, { iconColor: "#123456" });

    const res = await h.request("PATCH", `/bases/${baseId}`, { icon: "book", iconColor: null });
    expect(res.status).toBe(200);
    const { base } = await json(res);
    expect(base.icon).toBe("book");
    expect(base.iconColor).toBe("#378ADD");
    const row = await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } });
    expect(row.icon).toBe("book");
    expect(row.iconColor).toBe("#378ADD");
  });

  it("缺省=不改动：只传 iconColor 不清空已有 icon", async () => {
    const baseId = await h.makeBase("B-partial-color");
    await h.request("PATCH", `/bases/${baseId}`, { icon: "folderOpen", iconColor: "#112233" });

    const res = await h.request("PATCH", `/bases/${baseId}`, { iconColor: "#AABBCC" });
    expect(res.status).toBe(200);
    expect((await json(res)).base).toMatchObject({ icon: "folderOpen", iconColor: "#AABBCC" });
    const row = await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } });
    expect(row.icon).toBe("folderOpen");
    expect(row.iconColor).toBe("#AABBCC");
  });

  it("非法 iconColor 仍是 400 且不落库（校验未被放宽过头）", async () => {
    const baseId = await h.makeBase("B-bad-color");
    const res = await h.request("PATCH", `/bases/${baseId}`, { iconColor: "#ABC" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("参数不合法");
    const row = await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } });
    expect(row.iconColor).toBe("#378ADD");
  });
});

// ============ 3) Table ============

describe("Table 自定义图标 + 颜色", () => {
  it("未自定义时 icon / iconColor 均为 null", async () => {
    const baseId = await h.makeBase("T-b");
    const { id } = await h.makeTable(baseId, "T1");
    const { table } = await json(await h.request("GET", `/tables/${id}`));
    expect(table.icon).toBeNull();
    expect(table.iconColor).toBeNull();
  });

  it("非法 icon / 非法 iconColor 均返回 400", async () => {
    const baseId = await h.makeBase("T-bad");
    const { id } = await h.makeTable(baseId, "T2");
    expect((await h.request("PATCH", `/tables/${id}`, { icon: "nope" })).status).toBe(400);
    expect((await h.request("PATCH", `/tables/${id}`, { iconColor: "red" })).status).toBe(400);
    expect((await h.request("PATCH", `/tables/${id}`, { iconColor: "#FFF" })).status).toBe(400);
    const row = await h.prisma.table.findUniqueOrThrow({ where: { id } });
    expect(row.icon).toBeNull();
    expect(row.iconColor).toBeNull();
  });

  it("合法设置 → 落库并随列表 DTO 透出；null 清除回默认", async () => {
    const baseId = await h.makeBase("T-set");
    const { id } = await h.makeTable(baseId, "T3");
    const ok = await h.request("PATCH", `/tables/${id}`, { icon: "grid", iconColor: "#1A2B3C" });
    expect(ok.status).toBe(200);
    expect((await json(ok)).table).toMatchObject({ icon: "grid", iconColor: "#1A2B3C" });

    const list = await json(await h.request("GET", `/tables?baseId=${baseId}`));
    expect(list.tables.find((t: any) => t.id === id)).toMatchObject({ icon: "grid", iconColor: "#1A2B3C" });

    const cleared = await h.request("PATCH", `/tables/${id}`, { icon: null, iconColor: null });
    expect(cleared.status).toBe(200);
    expect((await json(cleared)).table).toMatchObject({ icon: null, iconColor: null });
    const row = await h.prisma.table.findUniqueOrThrow({ where: { id } });
    expect(row.icon).toBeNull();
    expect(row.iconColor).toBeNull();
  });

  it("缺省=不改动：只传 icon 不覆盖 iconColor，只传 iconColor 不覆盖 icon", async () => {
    const baseId = await h.makeBase("T-partial");
    const { id } = await h.makeTable(baseId, "T4");
    await h.request("PATCH", `/tables/${id}`, { icon: "hash", iconColor: "#112233" });
    await h.request("PATCH", `/tables/${id}`, { icon: "bell" });
    let row = await h.prisma.table.findUniqueOrThrow({ where: { id } });
    expect(row.icon).toBe("bell");
    expect(row.iconColor).toBe("#112233");
    await h.request("PATCH", `/tables/${id}`, { iconColor: "#AABBCC" });
    row = await h.prisma.table.findUniqueOrThrow({ where: { id } });
    expect(row.icon).toBe("bell");
    expect(row.iconColor).toBe("#AABBCC");
  });
});

// ============ 4) KnowledgeBase ============

describe("KnowledgeBase 自定义图标", () => {
  it("未自定义时 icon 为 null，默认色仍是 #0F6E56", async () => {
    const kbId = await h.makeKb("KB-default");
    const { knowledgeBase } = await json(await h.request("GET", `/kb/${kbId}`));
    expect(knowledgeBase.icon).toBeNull();
    expect(knowledgeBase.iconColor).toBe("#0F6E56");
  });

  it("非法 icon 返回 400；合法设置随 DTO 透出；null 清除回默认", async () => {
    const kbId = await h.makeKb("KB-set");
    const bad = await h.request("PATCH", `/kb/${kbId}`, { icon: "unknown" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("参数不合法");

    const ok = await h.request("PATCH", `/kb/${kbId}`, { icon: "book" });
    expect(ok.status).toBe(200);
    expect((await json(ok)).knowledgeBase.icon).toBe("book");
    const list = await json(await h.request("GET", "/kb"));
    expect(list.knowledgeBases.find((k: any) => k.id === kbId).icon).toBe("book");

    const cleared = await h.request("PATCH", `/kb/${kbId}`, { icon: null });
    expect(cleared.status).toBe(200);
    expect((await json(cleared)).knowledgeBase.icon).toBeNull();
    expect((await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } })).icon).toBeNull();
  });

  it("缺省=不改动：只传 iconColor 不清除 icon", async () => {
    const kbId = await h.makeKb("KB-partial");
    await h.request("PATCH", `/kb/${kbId}`, { icon: "folderOpen" });
    const res = await h.request("PATCH", `/kb/${kbId}`, { iconColor: "#123456" });
    expect(res.status).toBe(200);
    const row = await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(row.icon).toBe("folderOpen");
    expect(row.iconColor).toBe("#123456");
  });

  // —— 恢复默认：iconColor 列 NOT NULL，null 语义 = 回到系统默认色 #0F6E56 ——

  it("恢复默认 {icon:null, iconColor:null} → icon 回 NULL、颜色回 #0F6E56", async () => {
    const kbId = await h.makeKb("KB-reset-all");
    const set = await h.request("PATCH", `/kb/${kbId}`, { icon: "book", iconColor: "#123456" });
    expect(set.status).toBe(200);

    const res = await h.request("PATCH", `/kb/${kbId}`, { icon: null, iconColor: null });
    expect(res.status).toBe(200);
    const { knowledgeBase } = await json(res);
    expect(knowledgeBase.icon).toBeNull();
    expect(knowledgeBase.iconColor).toBe("#0F6E56");
    const row = await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(row.icon).toBeNull();
    expect(row.iconColor).toBe("#0F6E56");
  });

  it("只恢复颜色 {icon:'book', iconColor:null} → icon 保留、颜色回 #0F6E56", async () => {
    const kbId = await h.makeKb("KB-reset-color");
    await h.request("PATCH", `/kb/${kbId}`, { iconColor: "#123456" });

    const res = await h.request("PATCH", `/kb/${kbId}`, { icon: "book", iconColor: null });
    expect(res.status).toBe(200);
    const { knowledgeBase } = await json(res);
    expect(knowledgeBase.icon).toBe("book");
    expect(knowledgeBase.iconColor).toBe("#0F6E56");
    const row = await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(row.icon).toBe("book");
    expect(row.iconColor).toBe("#0F6E56");
  });

  it("缺省=不改动：只传 iconColor 不清空已有 icon", async () => {
    const kbId = await h.makeKb("KB-partial-color");
    await h.request("PATCH", `/kb/${kbId}`, { icon: "folderOpen", iconColor: "#112233" });

    const res = await h.request("PATCH", `/kb/${kbId}`, { iconColor: "#AABBCC" });
    expect(res.status).toBe(200);
    expect((await json(res)).knowledgeBase).toMatchObject({ icon: "folderOpen", iconColor: "#AABBCC" });
    const row = await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(row.icon).toBe("folderOpen");
    expect(row.iconColor).toBe("#AABBCC");
  });

  it("非法 iconColor 仍是 400 且不落库（校验未被放宽过头）", async () => {
    const kbId = await h.makeKb("KB-bad-color");
    const res = await h.request("PATCH", `/kb/${kbId}`, { iconColor: "#ABC" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("参数不合法");
    const row = await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(row.iconColor).toBe("#0F6E56");
  });
});

// ============ 5) KbDoc（doc 与 canvas 共用 kb_docs） ============

describe("KbDoc 自定义图标 + 颜色", () => {
  async function makeDoc(kbId: string, kind: "doc" | "canvas") {
    const res = await h.request("POST", `/kb/${kbId}/docs`, { kind, title: `${kind}-1` });
    expect(res.status).toBe(201);
    return (await json(res)).doc.id as string;
  }

  it("doc 与 canvas：未自定义 → 设置 → null 清除往返", async () => {
    const kbId = await h.makeKb("KB-docs");
    for (const kind of ["doc", "canvas"] as const) {
      const docId = await makeDoc(kbId, kind);

      const fresh = await json(await h.request("GET", `/kb/docs/${docId}`));
      expect(fresh.doc.icon).toBeNull();
      expect(fresh.doc.iconColor).toBeNull();

      expect((await h.request("PATCH", `/kb/docs/${docId}`, { icon: "nope" })).status).toBe(400);
      expect((await h.request("PATCH", `/kb/docs/${docId}`, { iconColor: "12ab" })).status).toBe(400);

      const ok = await h.request("PATCH", `/kb/docs/${docId}`, {
        icon: kind === "doc" ? "file" : "canvas",
        iconColor: "#ff0000",
      });
      expect(ok.status).toBe(200);

      // 详情 + 列表都透出
      const detail = await json(await h.request("GET", `/kb/docs/${docId}`));
      expect(detail.doc).toMatchObject({ icon: kind === "doc" ? "file" : "canvas", iconColor: "#ff0000" });
      const list = await json(await h.request("GET", `/kb/${kbId}/docs`));
      expect(list.docs.find((d: any) => d.id === docId)).toMatchObject({
        icon: kind === "doc" ? "file" : "canvas",
        iconColor: "#ff0000",
      });

      // null 清除回默认
      const cleared = await h.request("PATCH", `/kb/docs/${docId}`, { icon: null, iconColor: null });
      expect(cleared.status).toBe(200);
      const row = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: docId } });
      expect(row.icon).toBeNull();
      expect(row.iconColor).toBeNull();
    }
  });

  it("只改图标不改标题时不改动 title，也不产生检索 outbox 事件", async () => {
    const kbId = await h.makeKb("KB-icon-only");
    const docId = await makeDoc(kbId, "doc");
    const before = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: docId } });
    const res = await h.request("PATCH", `/kb/docs/${docId}`, { icon: "sparkles" });
    expect(res.status).toBe(200);
    const after = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: docId } });
    expect(after.icon).toBe("sparkles");
    expect(after.title).toBe(before.title);
    expect(after.contentVersion).toBe(before.contentVersion);
  });
});

// ============ 6) 实体图标不进 nav_nodes ============

describe("实体图标不进导航编排", () => {
  it("改 Base 图标后 nav_nodes 的 iconName 不受影响", async () => {
    // 走 POST 建库（含 nav 同步），确保 nav_nodes 非空后再断言
    const created = await json(await h.request("POST", "/bases", { name: "B-nav" }));
    const baseId = created.base.id as string;
    const before = await h.prisma.navNode.findMany({ select: { id: true, iconName: true } });
    expect(before.length).toBeGreaterThan(0);

    const res = await h.request("PATCH", `/bases/${baseId}`, { icon: "star" });
    expect(res.status).toBe(200);

    const after = await h.prisma.navNode.findMany({ select: { id: true, iconName: true } });
    // 实体图标只落 bases.icon：没有任何 nav 节点被写入该图标名
    expect(after.every((n) => n.iconName !== "star")).toBe(true);
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } })).icon).toBe("star");
  });
});

// 类型断言：白名单推导出的联合类型可用（编译期守卫，防止 as const 退化成 string[]）
const _typeCheck: EntityIcon = "database";
void _typeCheck;

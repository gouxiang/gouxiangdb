// M5/S1 commit B 验收：outbox 同事务接线（真库真迁移 + 真 HTTP，不 mock），覆盖计划 §5.2
// 四组：1) 共生死（trigger 注入 ABORT -> 真 500，业务表与 change_events 无半截）；
// 2) 合并去重（pending/failed 吸收、done 后新行）；3) 软删 delete/恢复 upsert、纯移动不发/
// 改名发；4) 表清空级联 delete、ANON 匿名 upsert、主写 P95 毫秒级。Prisma 5.22 把 trigger
// RAISE(ABORT) 归 P2003 不透传消息，故 500 只看状态码，核心靠回滚后两表无残留断言。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, json, failEntityWrite, stopFailing, type CharHarness } from "../../nav/__tests__/navRouteHarness.js";

let h: CharHarness;
const OWNER = "m5w_owner";
const B = "m5w_base";
const T = "m5w_table";
const FP = "m5w_fp";
const KB = "m5w_kb";

type Ev = { id: string; entityType: string; entityId: string; op: string; status: string; version: bigint };

async function eventsFor(entityType: string, entityId: string): Promise<Ev[]> {
  const rows = await h.prisma.changeEvent.findMany({
    where: { entityType, entityId }, orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id, entityType: r.entityType, entityId: r.entityId,
    op: r.op, status: r.status, version: r.version,
  }));
}

async function markDone(entityType: string, entityId: string): Promise<void> {
  await h.prisma.changeEvent.updateMany({
    where: { entityType, entityId },
    data: { status: "done", processedAt: new Date() },
  });
}

async function seedTable(): Promise<void> {
  await h.prisma.$transaction([
    h.prisma.base.create({ data: { id: B, name: "w base", createdBy: OWNER } }),
    h.prisma.member.create({ data: { id: "m5w_m", baseId: B, userId: OWNER, role: "owner" } }),
    h.prisma.table.create({ data: { id: T, baseId: B, name: "w table", primaryFieldId: FP, createdBy: OWNER } }),
    h.prisma.field.create({ data: { id: FP, tableId: T, name: "标题", type: "singleLineText", order: 0 } }),
  ]);
}

async function createRecord(title: string): Promise<{ res: Response; id: string }> {
  const res = await h.app.request(`/api/records?tableId=${T}`, {
    method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [FP]: title } }),
  });
  const body = await json<{ record: { id: string } }>(res);
  return { res, id: body.record.id };
}

async function patchRecord(id: string, title: string): Promise<Response> {
  return h.app.request(`/api/records/${id}`, {
    method: "PATCH", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [FP]: title } }),
  });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m5-s1-wire-");
  await h.createUser(OWNER, { email: "owner@m5w.x", displayName: "所有者" });
  // 权限核心模型（二）：库放行只看「角色 × 库」，脚手架 owner 挂超级管理员才动得了库。
  await h.grantRole(OWNER);
  await seedTable();
  await h.prisma.$transaction([
    h.prisma.knowledgeBase.create({ data: { id: KB, name: "w kb", createdBy: OWNER } }),
    h.prisma.kbMember.create({ data: { id: "m5w_km", kbId: KB, userId: OWNER, role: "owner" } }),
  ]);
});

afterAll(async () => {
  await stopFailing(h).catch(() => undefined);
  await h.cleanup();
});

describe("记录写点：建/改合并、done 后新行、软删恢复、共生死", () => {
  it("建+连改吸收同一 pending 行；done 后再改出新行", async () => {
    const { res, id } = await createRecord("客户甲");
    expect(res.status).toBe(201);
    let evs = await eventsFor("record", id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!).toMatchObject({ op: "upsert", status: "pending" });

    const patch = await patchRecord(id, "客户甲改");
    expect(patch.status).toBe(200);
    evs = await eventsFor("record", id);
    expect(evs).toHaveLength(1); // 第二次编辑被同一 pending 吸收
    expect(evs[0]!.op).toBe("upsert");

    await markDone("record", id);
    const patchAgain = await patchRecord(id, "客户甲再改");
    expect(patchAgain.status).toBe(200);
    evs = await eventsFor("record", id);
    expect(evs).toHaveLength(2); // done 不吸收，产生新 pending 行
    expect(evs.map((e) => e.status)).toEqual(["done", "pending"]);
    expect(evs[1]!.op).toBe("upsert");
  });

  it("软删发 delete（吸收 pending），恢复发 upsert", async () => {
    const { id } = await createRecord("客户乙");
    expect(await eventsFor("record", id)).toHaveLength(1);

    const del = await h.app.request(`/api/records/${id}`, {
      method: "DELETE", headers: await h.auth(OWNER),
    });
    expect(del.status).toBe(200);
    let evs = await eventsFor("record", id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.op).toBe("delete");

    const restore = await h.app.request(`/api/records/trash/${id}/restore`, {
      method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "record" }),
    });
    expect(restore.status).toBe(200);
    evs = await eventsFor("record", id);
    expect(evs).toHaveLength(1); // delete pending 被恢复 upsert 翻转吸收
    expect(evs[0]!.op).toBe("upsert");
  });

  it("注入失败：change_events INSERT ABORT -> 500，记录与事件两表无半截", async () => {
    const eventsBefore = await h.prisma.changeEvent.count();
    await failEntityWrite(h, "change_events", "INSERT");
    let status = 0;
    try {
      const res = await h.app.request(`/api/records?tableId=${T}`, {
        method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { [FP]: "应回滚客户" } }),
      });
      status = res.status;
    } finally {
      await stopFailing(h); // 无论断言成败必先清触发器，避免污染后续用例
    }
    expect(status).toBe(500);

    const recs = await h.prisma.record.findMany({ where: { tableId: T } });
    expect(recs.some((r) => r.fields.includes("应回滚客户"))).toBe(false); // 无半截记录
    expect(await h.prisma.changeEvent.count()).toBe(eventsBefore); // 无事件残留
  });
});

describe("文档/画布写点：建/内容/改名/移动/软删恢复/共生死", () => {
  async function createDoc(label: string, kind: "doc" | "canvas"): Promise<{ res: Response; id: string }> {
    const res = await h.app.request(`/api/kb/${KB}/docs`, {
      method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
      body: JSON.stringify({ kind, title: `${label} 标题` }),
    });
    const body = await json<{ doc: { id: string } }>(res);
    return { res, id: body.doc.id };
  }

  it("doc 建+内容保存合并，version 随 contentVersion", async () => {
    const { res, id } = await createDoc("m5w_d1", "doc");
    expect(res.status).toBe(201);
    let evs = await eventsFor("doc", id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.op).toBe("upsert");

    const put = await h.app.request(`/api/kb/docs/${id}/content`, {
      method: "PUT", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# 正文 检索词甲" }),
    });
    expect(put.status).toBe(200);
    const body = await json<{ contentVersion: number }>(put);
    expect(body.contentVersion).toBe(1);
    evs = await eventsFor("doc", id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.version).toBe(1n); // version=递增后的 contentVersion
  });

  it("canvas 实体类型为 canvas", async () => {
    const { res, id } = await createDoc("m5w_c1", "canvas");
    expect(res.status).toBe(201);
    const evs = await eventsFor("canvas", id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.op).toBe("upsert");
    expect(await eventsFor("doc", id)).toHaveLength(0);
  });

  it("改名（文本变）产生 upsert；纯移动不产生事件", async () => {
    const d2 = (await createDoc("m5w_d2", "doc")).id;
    const d3 = (await createDoc("m5w_d3", "doc")).id;
    await markDone("doc", d2);
    await markDone("doc", d3);

    const rename = await h.app.request(`/api/kb/docs/${d2}`, {
      method: "PATCH", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "改名后标题" }),
    });
    expect(rename.status).toBe(200);
    const afterRename = await eventsFor("doc", d2);
    expect(afterRename.some((e) => e.status === "pending" && e.op === "upsert")).toBe(true);

    const beforeMove = await h.prisma.changeEvent.count({ where: { entityId: d3 } });
    const move = await h.app.request(`/api/kb/docs/${d3}/move`, {
      method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: d2 }),
    });
    expect(move.status).toBe(200);
    const afterMove = await h.prisma.changeEvent.count({ where: { entityId: d3 } });
    expect(afterMove).toBe(beforeMove); // 纯移动不发内容事件
  });

  it("软删发 delete、恢复发 upsert", async () => {
    const id = (await createDoc("m5w_d4", "doc")).id;
    const del = await h.app.request(`/api/kb/docs/${id}`, {
      method: "DELETE", headers: await h.auth(OWNER),
    });
    expect(del.status).toBe(200);
    expect((await eventsFor("doc", id))[0]!.op).toBe("delete");

    const restore = await h.app.request(`/api/kb/docs/${id}/restore`, {
      method: "POST", headers: await h.auth(OWNER),
    });
    expect(restore.status).toBe(200);
    expect((await eventsFor("doc", id))[0]!.op).toBe("upsert");
  });

  it("注入失败：内容保存 500，contentVersion 未增且无事件残留", async () => {
    const id = (await createDoc("m5w_d5", "doc")).id;
    await markDone("doc", id); // 逼出 INSERT 新行而非 UPDATE 合并
    await failEntityWrite(h, "change_events", "INSERT");
    let status = 0;
    try {
      const put = await h.app.request(`/api/kb/docs/${id}/content`, {
        method: "PUT", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# 应回滚正文" }),
      });
      status = put.status;
    } finally {
      await stopFailing(h);
    }
    expect(status).toBe(500);

    const doc = await h.prisma.kbDoc.findUnique({ where: { id }, select: { contentVersion: true } });
    expect(doc?.contentVersion).toBe(0); // 主事务回滚，版本未递增
    const pending = (await eventsFor("doc", id)).filter((e) => e.status === "pending");
    expect(pending).toHaveLength(0);
  });
});

describe("ANON 公开写与表级联", () => {
  // 产品口径变更（M7 / 权限核心模型二）：分享链接对外一律只读，匿名写整体关闭，
  // 故公开编辑不再产生 upsert 事件。这里改锁"匿名写被拒且不产事件"。
  it("匿名公开编辑已被关闭：403 且不产生 upsert 事件", async () => {
    const docId = "m5w_pub";
    await h.prisma.kbDoc.create({
      data: {
        id: docId, kbId: KB, kind: "doc", title: "公开文档", content: "",
        shareEnabled: true, shareToken: "m5w-pub-token", shareRole: "editor",
        shareIncludeChildren: false, createdBy: OWNER, updatedBy: OWNER,
      },
    });
    const res = await h.app.request("/api/public/s/m5w-pub-token/doc/m5w_pub/content", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# 匿名写入正文 检索词乙" }),
    });
    expect(res.status).toBe(403);
    const evs = await eventsFor("doc", docId);
    expect(evs.some((e) => e.op === "upsert" && e.status === "pending")).toBe(false);
  });

  it("清空表：被清记录逐条 delete", async () => {
    const ids = [(await createRecord("客户丙")).id, (await createRecord("客户丁")).id];
    const clear = await h.app.request(`/api/tables/${T}/clear`, {
      method: "POST", headers: await h.auth(OWNER),
    });
    expect(clear.status).toBe(200);
    for (const id of ids) {
      const evs = await eventsFor("record", id);
      expect(evs[evs.length - 1]!.op).toBe("delete");
    }
  });
});

describe("主写 P95 留证（outbox 为同库单条额外写）", () => {
  it("record.create p95 在毫秒级（本机健康门，非跨硬件承诺）", async () => {
    const N = 30;
    const durations: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const { res } = await createRecord(`性能客户${i}`);
      durations.push(performance.now() - t0);
      expect(res.status).toBe(201);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(N * 0.95) - 1]!;
    const median = durations[Math.floor(N / 2)]!;
    // 实测值打印留证（M5 §3-2：额外 1 INSERT 预期 <1ms 量级，占整个写交互比例为噪声级）。
    console.log(`[m5-s1] record.create median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms (n=${N})`);
    expect(p95).toBeLessThan(150); // 本机健康上界，防回归，非对外承诺
  });
});

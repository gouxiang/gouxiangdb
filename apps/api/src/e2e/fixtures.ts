// M6/S8 e2e 夹具：真迁移库上的最小完整资源树 + 策略 + PAT。
//
// 设计（每族都造「可见 / 不可见」成对资源，且不可见资源**真实存在**）：
//   - 表族：base1/t1（可见）+ base2/t2（不可见）——字段 fVisible/fHidden 用于 AC-M6-2；
//   - doc 族：doc1（可见）+ docHidden（不可见）；
//   - canvas 族：cv1（可见）+ cvHidden（不可见）。
//   IDOR 对抗即拿"不可见但存在"的 id 与"根本不存在"的 id 对拍响应是否逐字节一致（不泄漏存在性）。
//
// nav 节点 id 一律用 nodeId(kind, resourceId)（确定性）：nav 同步会清理非确定性 id（S6b 已踩坑）。

import type { PrismaClient } from "@prisma/client";
import { createNavNodes, createPolicies } from "../domain/authz/__tests__/engineHarness.js";
import { nodeId } from "../domain/nav/backfill.js";
import type { PatScope } from "../mcp/pat/tokens.js";

export interface Fixtures {
  ids: {
    baseId: string; hiddenBaseId: string; tableId: string; hiddenTableId: string;
    fVisible: string; fHidden: string;
    docId: string; hiddenDocId: string; canvasId: string; hiddenCanvasId: string;
  };
  /** 不存在的 id（与"存在但不可见"对拍用）。 */
  ghost: { baseId: string; docId: string; canvasId: string };
  pat: Record<"full" | "ro" | "mask" | "canvasRo" | "canvasWo", { id: string; token: string }>;
}

export const DOC_SEED_MD = "# 标题\n\n正文段落。\n";
export const CANVAS_SEED = JSON.stringify([
  { id: "seed0", type: "geometry", shape: "rectangle", points: [[0, 0], [10, 10]] },
]);

async function createPat(prisma: PrismaClient, userId: string, name: string, scopes: PatScope[]) {
  const svc = await import("../mcp/pat/patService.js");
  const r = await svc.createPat(userId, { name, scopes, expiresInDays: 90 });
  return { id: r.pat.id, token: r.plaintext };
}

/** 建完整夹具（调用前须已 migrate + 已设 globalThis.__gx_prisma）。 */
export async function seedFixtures(prisma: PrismaClient): Promise<Fixtures> {
  const users = ["uFull", "uRo", "uMask", "uCanvasRo", "uCanvasWo", "uOther"];
  for (const id of users) {
    await prisma.user.create({
      data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
    });
  }

  // —— 表族 ——
  await prisma.base.create({ data: { id: "b1", name: "库一", createdBy: "uFull" } });
  const t1 = await prisma.table.create({ data: { baseId: "b1", name: "表一", primaryFieldId: "", createdBy: "uFull" } });
  const fVisible = await prisma.field.create({ data: { tableId: t1.id, name: "可见列", type: "singleLineText", order: 0 } });
  const fHidden = await prisma.field.create({ data: { tableId: t1.id, name: "隐藏列", type: "singleLineText", order: 1 } });
  await prisma.table.update({ where: { id: t1.id }, data: { primaryFieldId: fVisible.id } });
  await prisma.record.createMany({
    data: [0, 1].map((i) => ({
      tableId: t1.id,
      fields: JSON.stringify({ [fVisible.id]: `可见${i}`, [fHidden.id]: `隐藏${i}` }),
      createdBy: "uFull", updatedBy: "uFull",
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)), updatedAt: new Date(Date.UTC(2026, 0, 1 + i)),
    })),
  });
  // 不可见资源一律 createdBy=uOther：M4 的 createdBy 属主路径会让"自己建的"资源可见
  // （probe 实测踩到：hidden 由 uFull 建时 uFull 反而看得见，IDOR 对抗就假了）。
  await prisma.base.create({ data: { id: "b2", name: "库二", createdBy: "uOther" } });
  const t2 = await prisma.table.create({ data: { baseId: "b2", name: "表二", primaryFieldId: "", createdBy: "uOther" } });

  // —— doc / canvas 族 ——
  await prisma.knowledgeBase.create({ data: { id: "kb1", name: "知识库一", createdBy: "uFull" } });
  const doc = await prisma.kbDoc.create({
    data: { kbId: "kb1", kind: "doc", title: "文档一", content: DOC_SEED_MD, createdBy: "uFull", updatedBy: "uFull" },
  });
  const docHidden = await prisma.kbDoc.create({
    data: { kbId: "kb1", kind: "doc", title: "隐藏文档", content: "机密内容", createdBy: "uOther", updatedBy: "uOther" },
  });
  const cv = await prisma.kbDoc.create({
    data: { kbId: "kb1", kind: "canvas", title: "画布一", content: CANVAS_SEED, createdBy: "uFull", updatedBy: "uFull" },
  });
  const cvHidden = await prisma.kbDoc.create({
    data: { kbId: "kb1", kind: "canvas", title: "隐藏画布", content: "[]", createdBy: "uOther", updatedBy: "uOther" },
  });

  const nB1 = nodeId("base", "b1");
  const nT1 = nodeId("table", t1.id);
  const nB2 = nodeId("base", "b2");
  const nT2 = nodeId("table", t2.id);
  const nDoc = nodeId("doc", doc.id);
  const nDocHidden = nodeId("doc", docHidden.id);
  const nCv = nodeId("canvas", cv.id);
  const nCvHidden = nodeId("canvas", cvHidden.id);
  await createNavNodes(prisma, [
    { id: nB1, kind: "base", resourceType: "base", resourceId: "b1" },
    { id: nT1, kind: "table", resourceType: "table", resourceId: t1.id, parentId: nB1 },
    { id: nB2, kind: "base", resourceType: "base", resourceId: "b2" },
    { id: nT2, kind: "table", resourceType: "table", resourceId: t2.id, parentId: nB2 },
    { id: nDoc, kind: "doc", resourceType: "doc", resourceId: doc.id },
    { id: nDocHidden, kind: "doc", resourceType: "doc", resourceId: docHidden.id },
    { id: nCv, kind: "canvas", resourceType: "canvas", resourceId: cv.id },
    { id: nCvHidden, kind: "canvas", resourceType: "canvas", resourceId: cvHidden.id },
  ]);

  const mask = JSON.stringify({ allowFields: [fVisible.id] });
  await createPolicies(prisma, [
    // uFull：全动作（含 d，用于 delete_record 注册）
    { id: "p_full_b", nodeId: nB1, subjectType: "user", subjectId: "uFull", actions: "r,c,u,d" },
    { id: "p_full_t", nodeId: nT1, subjectType: "user", subjectId: "uFull", actions: "r,c,u,d" },
    { id: "p_full_d", nodeId: nDoc, subjectType: "user", subjectId: "uFull", actions: "r,u" },
    { id: "p_full_c", nodeId: nCv, subjectType: "user", subjectId: "uFull", actions: "r,u" },
    // uRo：只读
    { id: "p_ro_b", nodeId: nB1, subjectType: "user", subjectId: "uRo", actions: "r" },
    { id: "p_ro_t", nodeId: nT1, subjectType: "user", subjectId: "uRo", actions: "r" },
    { id: "p_ro_d", nodeId: nDoc, subjectType: "user", subjectId: "uRo", actions: "r" },
    { id: "p_ro_c", nodeId: nCv, subjectType: "user", subjectId: "uRo", actions: "r" },
    // uMask：r,u + 字段白名单（仅 fVisible）——AC-M6-2 的"字段受限凭证"
    { id: "p_mask_b", nodeId: nB1, subjectType: "user", subjectId: "uMask", actions: "r,u", fieldMask: mask },
    { id: "p_mask_t", nodeId: nT1, subjectType: "user", subjectId: "uMask", actions: "r,u", fieldMask: mask },
    // 画布只写 / 只读身份（S6b 口径沿用：列表与回执按 r 有无分流）
    { id: "p_cro", nodeId: nCv, subjectType: "user", subjectId: "uCanvasRo", actions: "r" },
    { id: "p_cwo", nodeId: nCv, subjectType: "user", subjectId: "uCanvasWo", actions: "u" },
  ]);

  return {
    ids: {
      baseId: "b1", hiddenBaseId: "b2", tableId: t1.id, hiddenTableId: t2.id,
      fVisible: fVisible.id, fHidden: fHidden.id,
      docId: doc.id, hiddenDocId: docHidden.id, canvasId: cv.id, hiddenCanvasId: cvHidden.id,
    },
    ghost: { baseId: "b_ghost", docId: "doc_ghost", canvasId: "cv_ghost" },
    pat: {
      full: await createPat(prisma, "uFull", "full", ["record:read", "record:write", "doc:read", "doc:write", "canvas:read", "canvas:write"]),
      ro: await createPat(prisma, "uRo", "ro", ["record:read", "doc:read", "canvas:read"]),
      mask: await createPat(prisma, "uMask", "mask", ["record:read", "record:write"]),
      canvasRo: await createPat(prisma, "uCanvasRo", "cro", ["canvas:read"]),
      canvasWo: await createPat(prisma, "uCanvasWo", "cwo", ["canvas:write"]),
    },
  };
}

// M4/S6 fieldMask on 态端到端对抗夹具（真迁移临时库 + 真 createApp/真 JWT，不 mock auth）。
//
// 拓扑（单 base 三表；links 字段只能指向同 base 的表，②档靠"无任何 r 来源"而非跨 base）：
//   base1(owner) ├ tableA 员工（名称/薪资[隐藏]/机密[隐藏]/只读编号 + 9 公式 + 两 links）
//                ├ tableB 客户（公司名[对 u_mask 隐藏] / 客户编号[可见但空] / 金额[隐藏]）
//                └ tableC 合同（合同名；u_mask 在 base 节点宽行已删、tableC 节点无任何策略
//                              -> cap.visible=false ②档表级不可见）
//   tableA.客户  links -> tableB（①档：表 r 可见但展示字段全 mask -> LinkRef.title=真实 recordId）
//   tableA.合同  links -> tableC（②档：对端表不可见 -> LinkRef 整体缺席 []，无 id/title/tableId）
//
// 关键夹具手法（spec §4.4 O8 并集最宽）：members 双写会在【base 节点】给 u_mask 落宽
// legacy 投影（fieldMask=null，会击败 table 节点任何窄 mask）。故建完实体后直接删掉 base1
// 节点上 u_mask 的全部策略行，只在 tableA/tableB 节点插窄 r/c/u 行、tableC 完全不插；
// members 旧表保持 editor 不动（旧守卫照常放行 HTTP，证明字段门是"旧表级 r 成立之后的
// 字段维只减不增"，节点守卫全局门仍 on->shadow）。u_mask 非任何表 creator、非 workspace
// owner，creator/owner 宽来源兜底不成立。

import type { PrismaClient } from "@prisma/client";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { nodeId } from "../../nav/backfill.js";

export const OWNER = "s6_owner";
export const MASK = "s6_mask";

export interface S6Fixture {
  h: CharHarness;
  prisma: PrismaClient;
  base1: string;
  A: string; // tableA
  B: string; // tableB
  C: string; // tableC
  viewA: string; // 带隐藏字段 filter/sort/group/agg 的视图
  f: {
    name: string;
    salary: string;
    secret: string;
    ro: string;
    cust: string; // A -> B links
    deal: string; // A -> C links
    fmRef: string;
    fmSum: string;
    fmAvg: string;
    fmMin: string;
    fmMax: string;
    fmConcat: string;
    fmArith: string;
    fmIsNull: string;
    lookupName: string;
    rollupAmt: string;
    countB: string;
    countC: string;
    dotSum: string;
    bname: string;
    bcode: string;
    bamt: string;
    cname: string;
  };
  rec: { A1: string; A2: string; A3: string; B1: string; B2: string; B3: string; C1: string };
  call: (method: string, url: string, user: string, body?: unknown) => Promise<Response>;
  /** on 态 u_mask 窄 mask 的可见字段 id 集（断言基准）。 */
  visibleA: () => string[];
}

async function fieldId(h: CharHarness, tableId: string, body: Record<string, unknown>): Promise<string> {
  const res = await h.app.request(`/api/fields?tableId=${tableId}`, {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`field create failed ${res.status}: ${await res.text()}`);
  return (await json<{ field: { id: string } }>(res)).field.id;
}

async function createRecord(h: CharHarness, tableId: string, fields: Record<string, unknown>): Promise<string> {
  const res = await h.app.request(`/api/records?tableId=${tableId}`, {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (res.status !== 201) throw new Error(`record create failed ${res.status}: ${await res.text()}`);
  return (await json<{ record: { id: string } }>(res)).record.id;
}

/** 建实体阶段固定 off（引擎不介入）；返回的 call 供用例自行切 GX_AUTHZ_ENGINE。 */
export async function setupS6MaskFixture(): Promise<S6Fixture> {
  delete process.env.GX_AUTHZ_ENGINE;
  delete process.env.GX_M1_SIDECAR_READ;
  delete process.env.GX_M1_KEYSET;
  const h = await setupCharHarness("gx-m4-s6-");
  await h.createUser(OWNER);
  await h.createUser(MASK);
  // 权限核心模型（二）：建库/进库/改结构一律看「角色 × 库」。脚手架 OWNER 挂超级管理员
  // 才有库视野；MASK 保持零角色（它靠节点窄策略进库，不靠角色）。
  await h.grantRole(OWNER);

  const call: S6Fixture["call"] = async (method, url, user, body) => {
    const headers: Record<string, string> = await h.auth(user);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };

  // ---- base + starter 表 A ----
  const b0 = await call("POST", "/api/bases", OWNER, { name: "s6-base" });
  const base1 = (await json<{ base: { id: string } }>(b0)).base.id;
  const t0 = await call("GET", `/api/tables?baseId=${base1}`, OWNER);
  const tables0 = await json<{ tables: Array<{ id: string; primaryFieldId: string }> }>(t0);
  const A = tables0.tables[0]!.id;
  const name = tables0.tables[0]!.primaryFieldId;

  const mkTable = async (tableName: string): Promise<string> => {
    const c = await call("POST", `/api/tables?baseId=${base1}`, OWNER, { name: tableName });
    return (await json<{ table: { id: string } }>(c)).table.id;
  };
  const B = await mkTable("客户");
  const C = await mkTable("合同");

  // ---- tableB / tableC 字段（先建对端，links 才能挂 linkDisplayFieldId）----
  const bname = await fieldId(h, B, { name: "公司名", type: "singleLineText" });
  const bcode = await fieldId(h, B, { name: "客户编号", type: "singleLineText" });
  const bamt = await fieldId(h, B, { name: "金额", type: "number", precision: 0 });
  const cname = await fieldId(h, C, { name: "合同名", type: "singleLineText" });

  // ---- tableA 字段 ----
  const salary = await fieldId(h, A, { name: "薪资", type: "number", precision: 0 });
  const secret = await fieldId(h, A, { name: "机密备注", type: "longText" });
  const ro = await fieldId(h, A, { name: "只读编号", type: "singleLineText" });
  const cust = await fieldId(h, A, {
    name: "客户", type: "links", relatedTableId: B, relationKind: "mm", linkDisplayFieldId: bname,
  });
  const deal = await fieldId(h, A, {
    name: "合同", type: "links", relatedTableId: C, relationKind: "mm", linkDisplayFieldId: cname,
  });
  const fmRef = await fieldId(h, A, { name: "F引用", type: "formula", formula: "{薪资}" });
  const fmSum = await fieldId(h, A, { name: "F求和", type: "formula", formula: "SUM({薪资})" });
  const fmAvg = await fieldId(h, A, { name: "F均值", type: "formula", formula: "AVERAGE({薪资})" });
  const fmMin = await fieldId(h, A, { name: "F最小", type: "formula", formula: "MIN({薪资})" });
  const fmMax = await fieldId(h, A, { name: "F最大", type: "formula", formula: "MAX({薪资})" });
  const fmConcat = await fieldId(h, A, { name: "F拼接", type: "formula", formula: 'CONCAT("n=",{薪资})' });
  const fmArith = await fieldId(h, A, { name: "F算术", type: "formula", formula: "{薪资}*2+1" });
  const fmIsNull = await fieldId(h, A, { name: "F判空", type: "formula", formula: "ISNULL({薪资})" });
  const dotSum = await fieldId(h, A, { name: "F点求和", type: "formula", formula: "SUM({客户.金额})" });
  const lookupName = await fieldId(h, A, { name: "查公司名", type: "lookup", linkFieldId: cust, lookupFieldId: bname });
  const rollupAmt = await fieldId(h, A, {
    name: "汇金额", type: "rollup", linkFieldId: cust, lookupFieldId: bamt, rollupFunction: "sum",
  });
  const countB = await fieldId(h, A, { name: "客户数", type: "count", linkFieldId: cust });
  const countC = await fieldId(h, A, { name: "合同数", type: "count", linkFieldId: deal });

  // ---- 记录 ----
  const B1 = await createRecord(h, B, { [bname]: "甲公司", [bcode]: "", [bamt]: 100 });
  const B2 = await createRecord(h, B, { [bname]: "乙公司", [bcode]: "", [bamt]: 200 });
  const B3 = await createRecord(h, B, { [bname]: "丙公司", [bcode]: "", [bamt]: null });
  const C1 = await createRecord(h, C, { [cname]: "大合同" });
  const A1 = await createRecord(h, A, {
    [name]: "研发张三", [salary]: null, [secret]: "机密-1", [ro]: "RO-1",
    [cust]: [B1, B2], [deal]: [C1],
  });
  const A2 = await createRecord(h, A, {
    [name]: "研发李四", [salary]: 888, [secret]: "机密-2", [ro]: "RO-2",
    [cust]: [B3], [deal]: [C1],
  });
  const A3 = await createRecord(h, A, {
    [name]: "研发王五", [salary]: 300, [secret]: null, [ro]: "RO-3",
    [cust]: [], [deal]: [],
  });

  // ---- 带隐藏字段引用的视图（filter/sort/group/agg 全借隐藏列；脱敏后对 u_mask 等同无 config）----
  const vp = await call("POST", `/api/views?tableId=${A}`, OWNER, {
    name: "mask-view", type: "grid",
    config: {
      filters: { kind: "condition", fieldId: salary, op: "isNotEmpty", value: "" },
      sorts: [{ fieldId: salary, direction: "desc" }],
      groupByFieldId: salary,
      aggregations: { [salary]: "sum", [name]: "countFilled" },
    },
  });
  const viewA = (await json<{ view: { id: string } }>(vp)).view.id;

  // ---- u_mask 旧三表成员（editor）；双写会在 base 节点落宽 legacy 行 ----
  // 权限核心模型（二）后 members.role 已不参与放行，保留此行仅为导航旧表投影的台账。
  await h.prisma.member.create({ data: { id: "s6_member_mask", baseId: base1, userId: MASK, role: "editor" } });

  // ---- u_mask 的「角色 × 库」视野：新模型下这是它唯一能进库门的来源 ----
  // 档位对拍节点策略：A 可读可写、B 只读、C 显式全 false（②档表级不可见；不配会兜底成只读可见）。
  await h.prisma.role.create({
    data: { id: "s6_role_mask", workspaceId: "ws_default", name: "s6 掩码档", isSystem: 0, permissions: "[]" },
  });
  await h.prisma.roleAssignment.create({
    data: { roleId: "s6_role_mask", subjectType: "user", subjectId: MASK, scopeType: "workspace", createdBy: "seed" },
  });
  await h.prisma.roleLibraryScope.create({
    data: {
      roleId: "s6_role_mask", libraryKind: "base", libraryId: base1, canManage: 0, visible: 1,
      config: JSON.stringify({
        tables: {
          [A]: { read: true, create: true, update: true, delete: false },
          [B]: { read: true, create: false, update: false, delete: false },
          [C]: { read: false, create: false, update: false, delete: false },
        },
        fields: {},
      }),
    },
  });

  // 删除 base 节点 u_mask 宽投影（O8：宽来源在 base 会击败 table 窄 mask，必须收窄宽来源本身），
  // 改为在 table 节点挂窄策略；tableC 完全不插行 -> ②档表级不可见。
  await h.prisma.authPolicy.deleteMany({
    where: { nodeId: nodeId("base", base1), subjectId: MASK },
  });
  const visibleCols = [
    name, ro, cust, deal, fmRef, fmSum, fmAvg, fmMin, fmMax, fmConcat, fmArith, fmIsNull,
    dotSum, lookupName, rollupAmt, countB, countC,
  ];
  await h.prisma.authPolicy.create({
    data: {
      id: "s6_pol_a_mask", workspaceId: "ws_default", nodeId: nodeId("table", A),
      subjectType: "user", subjectId: MASK, actions: "r,c,u",
      fieldMask: JSON.stringify({ allowFields: visibleCols, readOnlyFields: [ro] }),
      reason: "test:direct", createdBy: OWNER,
    },
  });
  // tableB：r 可见但只允许 bcode（展示值全空），bname/bamt 被 mask（①档 + 跨表点引用 mask-null）。
  await h.prisma.authPolicy.create({
    data: {
      id: "s6_pol_b_mask", workspaceId: "ws_default", nodeId: nodeId("table", B),
      subjectType: "user", subjectId: MASK, actions: "r",
      fieldMask: JSON.stringify({ allowFields: [bcode] }),
      reason: "test:direct", createdBy: OWNER,
    },
  });
  // tableC：不插任何行 -> cutoff 链（tableC -> base）无 r 来源 -> cap.visible=false。

  const f = {
    name, salary, secret, ro, cust, deal, fmRef, fmSum, fmAvg, fmMin, fmMax, fmConcat,
    fmArith, fmIsNull, lookupName, rollupAmt, countB, countC, dotSum, bname, bcode, bamt, cname,
  };
  return {
    h, prisma: h.prisma, base1, A, B, C, viewA, f,
    rec: { A1, A2, A3, B1, B2, B3, C1 }, call,
    visibleA: () => visibleCols,
  };
}

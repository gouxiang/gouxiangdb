// scripts/acceptance/golden/scenarios.mjs
// B2~B5：升级后经 v1 API 构造 v0.1.0 无法播种的新结构并断言（写操作，在纯净态 golden/LCG 之后跑）。
//   B2 g7 多源并集（table 内容节点：base commenter 继承 + 部门授予 c/u）
//   B3 部门子树（table 内容节点：子部门成员命中祖先部门授予，外人不命中）
//   B4 继承中断（未确认 409 / confirmed 200 / 孙节点失权 / 幂等 impact.count=0）
//   B5 g8 停用闭环（旧 token 401、重登 401、members 投影行保留）
//
// 注：2026-09-21 commit 9a96364 库门重构后，base 库门节点不再接受裸 c/u/r（actionLegalForNode
// 仅收聚合位 enter/edit_data/manage_*），故 B2/B3 的内容动作授予与断言一律下放到 table 内容节点；
// 内容动作在表节点仍按引擎正常沿 base 继承/判定，多源并集与部门子树语义不变。

const SUBJECT_PASSWORD = "drill-pass-2026";
const norm = (actions) => [...actions].sort();
const eqSet = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const nodeId = (kind, rid) => `nav_${kind}_${rid}`;

// ---------- B2：g7 多源并集（table 内容节点） ----------
export async function scenarioUnion(api, ctx) {
  const { userByEmail, effective, byTag, gLegacy, table1, record } = ctx;
  const g7 = await userByEmail(byTag[gLegacy.g7.tag]);
  const before = await effective(g7, "table", table1);
  const dept = await api.post("/api/v1/org/departments", { name: "黄金g7-授权部" });
  await api.put(`/api/v1/nodes/${nodeId("table", table1)}/policies`, {
    upserts: [{ subjectType: "dept", subjectId: dept.id, actions: ["c", "u"] }],
  });
  await api.post(`/api/v1/org/members/${g7}/departments`, { add: [dept.id] });
  const after = await effective(g7, "table", table1);
  record({
    case: "g7 并集前 commenter 沿 base 继承到 table", tag: gLegacy.g7.tag, node: `table:${table1}`,
    want: ["r", "comment"], got: before.actions, httpStatus: before.status,
    pass: before.status === 200 && eqSet(before.actions, ["r", "comment"]),
  });
  record({
    case: "g7 多源并集(commenter继承+dept c/u)", tag: gLegacy.g7.tag, node: `table:${table1}`,
    want: norm(["r", "comment", "c", "u"]), got: after.actions, httpStatus: after.status, deptId: dept.id,
    pass: after.status === 200 && eqSet(after.actions, ["r", "comment", "c", "u"]),
  });
}

// ---------- B3：部门子树祖先闭包（table 内容节点） ----------
// 必须选对目标 base 之 table【无任何既有继承角色】的干净主体，否则 creator/owner 继承会盖过部门 r。
// base2 上 s09 本就是 creator（脏）、s13 editor、s20/s08 viewer；s12 的 base 角色在 base3、
// s10 无任何 base2 角色——二者对 base2 的 table 均干净（授权全集见 manifest randomGrants/goldenLegacy）。
export async function scenarioDeptSubtree(api, ctx) {
  const { userByEmail, effective, byTag, table2 } = ctx;
  const parent = await api.post("/api/v1/org/departments", { name: "黄金-子树父部" });
  const child = await api.post("/api/v1/org/departments", { name: "黄金-子树子部", parentId: parent.id });
  const inside = await userByEmail(byTag.s12);
  const outside = await userByEmail(byTag.s10);
  await api.post(`/api/v1/org/members/${inside}/departments`, { add: [child.id] });
  await api.put(`/api/v1/nodes/${nodeId("table", table2)}/policies`, {
    upserts: [{ subjectType: "dept", subjectId: parent.id, actions: ["r"] }],
  });
  const inGot = await effective(inside, "table", table2);
  const outGot = await effective(outside, "table", table2);
  return {
    parentDept: parent.id, childDept: child.id, insideTag: "s12", outsideTag: "s10",
    node: `table:${table2}`, inside: inGot.actions, outside: outGot.actions,
    pass: inGot.status === 200 && eqSet(inGot.actions, ["r"])
      && outGot.status === 200 && eqSet(outGot.actions, []),
  };
}

// ---------- B4：继承中断 ----------
// cutoff 权威语义（见 s10-ac-cutoff-grandchild 规则1/2）：节点 D1 inherit=0 后，
//   - D1 自身链只收自己，不再继承其上（kb/base）的授予；
//   - 子孙 D2 的链向上收到边界 D1 为止：D1【自身】策略仍及 D2，但 D1 之上（kb）的授予被挡。
// 故要坐实"孙节点失权"，须把 r 授在边界【之上】的 kb 节点：切断后 D1 与 D2 都失去来自 kb 的 r。
export async function scenarioCutoff(api, ctx) {
  const { userByEmail, effective, byTag, kbId } = ctx;
  const sub = await userByEmail(byTag.s11);
  const d1 = await api.post(`/api/kb/${kbId}/docs`, { kind: "doc", title: "黄金-继承中断D1" });
  const d2 = await api.post(`/api/kb/${kbId}/docs`, { kind: "doc", title: "黄金-继承中断D2", parentId: d1.doc.id });
  const d1Id = d1.doc.id; const d2Id = d2.doc.id;
  await api.put(`/api/v1/nodes/${nodeId("kb", kbId)}/policies`, {
    upserts: [{ subjectType: "user", subjectId: sub, actions: ["r"] }],
  });
  const preD2 = await effective(sub, "doc", d2Id);
  const preD1 = await effective(sub, "doc", d1Id);
  const unconfirmed = await api.raw("PATCH", `/api/v1/nodes/${nodeId("doc", d1Id)}/inheritance`, { value: false });
  const patch = await api.raw("PATCH", `/api/v1/nodes/${nodeId("doc", d1Id)}/inheritance`, { value: false, confirmed: true });
  const postD2 = await effective(sub, "doc", d2Id);
  const postD1 = await effective(sub, "doc", d1Id);
  const idem = await api.raw("PATCH", `/api/v1/nodes/${nodeId("doc", d1Id)}/inheritance`, { value: false, confirmed: true });
  return {
    subjectTag: "s11", grantNode: `kb:${kbId}`, d1: d1Id, d2: d2Id,
    preD2: preD2.actions, preD1: preD1.actions, postD2: postD2.actions, postD1: postD1.actions,
    unconfirmedStatus: unconfirmed.status, unconfirmedCode: unconfirmed.json?.code,
    patchStatus: patch.status, idempotentStatus: idem.status, idempotentCount: idem.json?.impact?.count ?? null,
    pass: preD2.status === 200 && eqSet(preD2.actions, ["r"])
      && preD1.status === 200 && eqSet(preD1.actions, ["r"])
      && unconfirmed.status === 409 && unconfirmed.json?.code === "INHERITANCE_CONFIRM_REQUIRED"
      && patch.status === 200
      && postD2.status === 200 && eqSet(postD2.actions, [])
      && postD1.status === 200 && eqSet(postD1.actions, [])
      && idem.status === 200 && (idem.json?.impact?.count ?? 0) === 0,
  };
}

// ---------- B5：g8 停用闭环 ----------
export async function scenarioDisabled(api, ctx) {
  const { userByEmail, baseUrl, byTag, gLegacy, base2, db, createClient, nodeId: nid } = ctx;
  const g8 = await userByEmail(byTag[gLegacy.g8.tag]);
  const pre = await api.raw("POST", "/auth/login", { email: byTag[gLegacy.g8.tag], password: SUBJECT_PASSWORD });
  const oldToken = pre.json?.token;
  // disable 必须用 raw：api.post 返回的是 body（其中恰有 status:"DISABLED"），会与 HTTP 状态混淆。
  const disable = await api.raw("POST", `/api/v1/org/members/${g8}/disable`, {});
  const loginAfter = await api.raw("POST", "/auth/login", { email: byTag[gLegacy.g8.tag], password: SUBJECT_PASSWORD });
  const oldJwt = createClient(baseUrl);
  oldJwt.setToken(oldToken);
  const oldCall = await oldJwt.raw("GET", `/api/v1/nodes/${nid("base", base2)}/effective`);
  const memberRow = db.prepare("SELECT count(*) c FROM members WHERE userId=?").get(g8).c;
  return {
    tag: gLegacy.g8.tag, userId: g8,
    disableHttpStatus: disable.status, disabledState: disable.status === 200 ? disable.json?.status : null,
    loginAfterStatus: loginAfter.status,
    oldJwtAfterStatus: oldCall.status,
    legacyMemberRowKept: memberRow,
    pass: disable.status === 200 && disable.json?.status === "DISABLED"
      && loginAfter.status === 401 && oldCall.status === 401 && memberRow >= 1,
  };
}

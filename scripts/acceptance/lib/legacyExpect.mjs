// scripts/acceptance/lib/legacyExpect.mjs
// v0.1.0 旧三表决策语义的【独立】期望计算器（裸 SQL 读 members/kb_members/kb_doc_acls，
// 不 import 任何 M4 引擎/回填代码），仅供黄金值与 LCG 自动对拍推导"旧库应得动作集"。
//
// 这是补强②"禁止循环论证"的关键：期望值来自旧版产品语义（角色动作档 + kb/doc 取较高 +
// 沿 nav 祖先链继承 + createdBy 兜底），而不是来自迁移投影或引擎输出。
//
// 资源动作全集（与 packages/shared-types/src/authz.ts 同序，字典序）。
export const ALL_ACTIONS = ["r", "c", "u", "d", "comment", "manage_share", "manage_schema"];

// 内容节点（table/doc/canvas/view）呈现面 11 枚中 creator 兜底所得：evaluate.ts 的 ADMIN_ACTIONS
// 只排除 manage_table（纯组织管理权，收权后不得凭"东西是我建的"拿回），其余 10 枚全给。
// 这是 2026-09-21 库门/动作集扩展后的独立第二份拷贝（故意不 import @gx 包）。
export const CREATOR_FALLBACK_ACTIONS = [
  "r", "c", "u", "d", "comment",
  "manage_share", "manage_schema", "enter", "edit_data", "share_link",
];

// 库门节点（base/kb）effective 只呈现聚合/管理位，不呈现内容动作 r/c/u/d/comment
// （policyQuery.explainEffective 对库节点过滤；2026-09-21 commit 9a96364 有意重构）。
// 旧七动作档（members/kb_members 裸 SQL）里只有 manage_share/manage_schema 会落进库门呈现位：
//   enter/edit_data 仅由 role_library_scope 投影产生（本计算器刻意不读 scope——存量普通成员均为
//   role_restricted、无 scope 行，故其库门不出现 enter/edit_data）；share_link 旧档从不携带。
// 因此旧逐库成员在库门上的期望 = 旧档动作 ∩ 该库门【旧档可命中】的呈现位。
// base 旧档可能命中 manage_share(owner)/manage_schema(owner,creator)；kb 仅 manage_share(owner)。
const BASE_GATE_FROM_LEGACY = ["manage_share", "manage_schema"];
const KB_GATE_FROM_LEGACY = ["manage_share"];

// 旧三档角色动作（逐字抄自 shared-types/authz.ts BASE/KB/DOC 三张表；此处是独立第二份拷贝，
// 故意不 import @gx 包——若将来映射漂移，本门会发现，而不是自证）。
const BASE_ROLE = {
  owner: ["r", "c", "u", "d", "comment", "manage_share", "manage_schema"],
  creator: ["r", "c", "u", "d", "comment", "manage_schema"],
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};
const KB_ROLE = {
  owner: ["r", "c", "u", "d", "comment", "manage_share"],
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};
const DOC_ROLE = {
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};

/** 集合并（去重），保持 ALL_ACTIONS 顺序输出。 */
function union(...sets) {
  const hit = new Set();
  for (const s of sets) for (const a of s || []) hit.add(a);
  return ALL_ACTIONS.filter((a) => hit.has(a));
}

/**
 * 从只读 db 装载旧授权索引。db 为 lib/db.mjs 的只读 better-sqlite3 连接。
 * 返回结构里所有 key 均为实际资源/用户 id。
 */
export function loadLegacyGrants(db) {
  const baseMembers = new Map(); // `${baseId}|${userId}` -> role
  for (const r of db.prepare("SELECT baseId, userId, role FROM members").all()) {
    baseMembers.set(`${r.baseId}|${r.userId}`, r.role);
  }
  const kbMembers = new Map(); // `${kbId}|${userId}` -> role
  for (const r of db.prepare("SELECT kbId, userId, role FROM kb_members").all()) {
    kbMembers.set(`${r.kbId}|${r.userId}`, r.role);
  }
  const docAcls = new Map(); // `${docId}|${userId}` -> role
  for (const r of db.prepare("SELECT docId, userId, role FROM kb_doc_acls").all()) {
    docAcls.set(`${r.docId}|${r.userId}`, r.role);
  }
  // 活文档 createdBy（creator 兜底）：仅活 doc/canvas。
  const docOwner = new Map(); // docId -> createdBy
  const docMeta = new Map(); // docId -> {kbId, kind, parentId, deletedAt}
  for (const r of db
    .prepare("SELECT id, kbId, kind, parentId, createdBy, deletedAt FROM kb_docs")
    .all()) {
    docOwner.set(r.id, r.createdBy);
    docMeta.set(r.id, { kbId: r.kbId, kind: r.kind, parentId: r.parentId, deletedAt: r.deletedAt });
  }
  const tableBase = new Map(); // tableId -> baseId
  for (const r of db.prepare("SELECT id, baseId FROM tables").all()) tableBase.set(r.id, r.baseId);
  return { baseMembers, kbMembers, docAcls, docOwner, docMeta, tableBase };
}

/**
 * 计算某用户对某 nav 实体节点【在旧语义下】应得的动作集（不考虑停用——停用归鉴权层，
 * 投影仍保留，见迁移 18 与 backfill-reconcile 测试）。
 *
 * @param {object} g loadLegacyGrants 产物
 * @param {string} userId
 * @param {{kind:"base"|"kb"|"table"|"doc"|"canvas", resourceId:string}} node
 */
export function expectedActionsFor(g, userId, node) {
  if (node.kind === "base") {
    // 库门呈现位（2026-09-21 重构）：旧逐库成员档只有 manage_share/manage_schema 会落到
    // 库门 effective；内容动作 r/c/u/d/comment 不在库门呈现，enter/edit_data 仅 scope 投影
    // （存量普通成员无 scope 行）。故 viewer/editor/commenter→[]，creator→[manage_schema]，
    // owner→[manage_share,manage_schema]。
    const legacy = BASE_ROLE[g.baseMembers.get(`${node.resourceId}|${userId}`)] ?? [];
    return ALL_ACTIONS.filter((a) => BASE_GATE_FROM_LEGACY.includes(a) && legacy.includes(a));
  }
  if (node.kind === "table") {
    // 表/视图/记录是内容节点：effective 呈现全部内容动作 + manage_schema，仍按 base 成员档。
    const baseId = g.tableBase.get(node.resourceId);
    return baseId ? (BASE_ROLE[g.baseMembers.get(`${baseId}|${userId}`)] ?? []) : [];
  }
  if (node.kind === "kb") {
    // kb 库门呈现位：旧 kb 成员档仅 owner 的 manage_share 落呈现位；内容动作不在库门呈现，
    // enter/share_link 仅 scope 投影。故 viewer/editor/commenter→[]，owner→[manage_share]。
    const legacy = KB_ROLE[g.kbMembers.get(`${node.resourceId}|${userId}`)] ?? [];
    return ALL_ACTIONS.filter((a) => KB_GATE_FROM_LEGACY.includes(a) && legacy.includes(a));
  }
  if (node.kind === "doc" || node.kind === "canvas") {
    const meta = g.docMeta.get(node.resourceId);
    if (!meta || meta.deletedAt) return [];
    // creator 兜底：内容节点上除 manage_table（ADMIN_ACTIONS）外 10 枚全给（含新聚合位/建链位）。
    if (g.docOwner.get(node.resourceId) === userId) return [...CREATOR_FALLBACK_ACTIONS];
    const kbSet = KB_ROLE[g.kbMembers.get(`${meta.kbId}|${userId}`)] ?? [];
    const aclSet = DOC_ROLE[g.docAcls.get(`${node.resourceId}|${userId}`)] ?? [];
    // 旧版 kb 成员档与 doc ACL「取较高」= 并集（editor 是 viewer 超集，并集即取高）。
    return union(kbSet, aclSet);
  }
  return [];
}

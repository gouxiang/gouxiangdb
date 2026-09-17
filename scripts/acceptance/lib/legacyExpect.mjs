// scripts/acceptance/lib/legacyExpect.mjs
// v0.1.0 旧三表决策语义的【独立】期望计算器（裸 SQL 读 members/kb_members/kb_doc_acls，
// 不 import 任何 M4 引擎/回填代码），仅供黄金值与 LCG 自动对拍推导"旧库应得动作集"。
//
// 这是补强②"禁止循环论证"的关键：期望值来自旧版产品语义（角色动作档 + kb/doc 取较高 +
// 沿 nav 祖先链继承 + createdBy 兜底），而不是来自迁移投影或引擎输出。
//
// 资源动作全集（与 packages/shared-types/src/authz.ts 同序，字典序）。
export const ALL_ACTIONS = ["r", "c", "u", "d", "comment", "manage_share", "manage_schema"];

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
    return BASE_ROLE[g.baseMembers.get(`${node.resourceId}|${userId}`)] ?? [];
  }
  if (node.kind === "table") {
    // 表/视图/记录动作在旧版一律按其 base 成员档（无逐表授权）。
    const baseId = g.tableBase.get(node.resourceId);
    return baseId ? (BASE_ROLE[g.baseMembers.get(`${baseId}|${userId}`)] ?? []) : [];
  }
  if (node.kind === "kb") {
    return KB_ROLE[g.kbMembers.get(`${node.resourceId}|${userId}`)] ?? [];
  }
  if (node.kind === "doc" || node.kind === "canvas") {
    const meta = g.docMeta.get(node.resourceId);
    if (!meta || meta.deletedAt) return [];
    // creator 兜底：文档创建者拿全七动作（引擎 creator fallback 对七动作恒 allow）。
    if (g.docOwner.get(node.resourceId) === userId) return [...ALL_ACTIONS];
    const kbSet = KB_ROLE[g.kbMembers.get(`${meta.kbId}|${userId}`)] ?? [];
    const aclSet = DOC_ROLE[g.docAcls.get(`${node.resourceId}|${userId}`)] ?? [];
    // 旧版 kb 成员档与 doc ACL「取较高」= 并集（editor 是 viewer 超集，并集即取高）。
    return union(kbSet, aclSet);
  }
  return [];
}

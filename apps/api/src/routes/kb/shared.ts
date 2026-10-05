// apps/api/src/routes/kb/shared.ts
// 知识库路由共享层：库/文档访问守卫、shadow 对拍缝、分享令牌/防环辅助。
//
// 权限核心模型重构后：本文件不再有自己的判定逻辑。
// requireKb / requireDocAccess 的放行与拦截全部来自 domain/authz/libraryPolicy.ts 的
// resolveKbAccess —— 与 Base 侧共用同一个裁决模块。旧的「kb_members 角色」与
// 「单篇文档 ACL 取较高者」两条判定均已退出：
//   - kb_members：不再是授权入口（谁进得来由角色的库视野决定），只作为历史成员留档；
//   - kb_doc_acls：彻底不参与放行。单篇文档的独立授权入口已连同 routes/kb/acl.ts 一起删除，
//     否则会留下一个"配了也对权限毫无影响"的死开关（这正是本次要消灭的形态）。
// 知识库没有"表"，文档与画布共用 content 这一档对象的增/删/改/查。

import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { authzShadowActive } from "../../configAuthz.js";
import { runShadowCheck } from "../../domain/authz/adapter.js";
import { enforceOrLegacy } from "../../domain/authz/enforceGate.js";
import type { LibraryAccessDTO } from "@gx/shared-types";
import { contentAccessOf, resolveKbAccess } from "../../domain/authz/libraryPolicy.js";

export type Role = "owner" | "editor" | "commenter" | "viewer";

/**
 * M4/S3 shadow 对拍缝：仅 GX_AUTHZ_ENGINE 生效为 shadow 时跑引擎同上下文对拍；
 * off 时空操作零新增 SQL。旧决策永远为准，对拍只分类计数/脱敏日志、不改返回、不抛错。
 */
export async function shadowKbAction(
  guard: string,
  userId: string,
  kbId: string,
  action: "r" | "c" | "d" | "enter" | "manage_share",
  oldAllowed: boolean,
): Promise<void> {
  if (!authzShadowActive()) return;
  await runShadowCheck(guard, userId, { resourceType: "kb", resourceId: kbId }, action, oldAllowed);
}

/** requireKb 成员资格对拍（kb 节点 enter 库门，= legacy access.visible）。 */
async function shadowKb(userId: string, kbId: string, oldAllowed: boolean): Promise<void> {
  await shadowKbAction("requireKb", userId, kbId, "enter", oldAllowed);
}

/**
 * kb.delete 统一裁定，口径对齐 requireCanDeleteBase（裁决 §5.1）：引擎动作词汇无「删库」位，
 * 以 conjunction 借 "d" 作必要条件（删 kb 必删内容），权威答案仍是 legacy canDeleteLibrary（仅超管）。
 * off 零 IO 返回 legacy；shadow 正向对拍；on 态结论 = legacy ∧ engine，非超管不被 d 放大。
 */
export async function enforceKbDelete(
  userId: string,
  kbId: string,
  legacyAllowed: boolean,
): Promise<boolean> {
  const out = await enforceOrLegacy({
    guard: "kb.delete",
    userId,
    ref: { resourceType: "kb", resourceId: kbId },
    action: "d",
    legacyAllowed,
    semantics: "conjunction",
  });
  return out.allowed;
}

/**
 * 由唯一裁决结果推出一个"展示档位"：canManage→owner / 能写内容→editor / 能看→viewer。
 * 保持旧返回形态是为了不牵动十几个调用点；但它已经【不再表示任何授权】——
 * 真正的判据永远是随结果一起返回的 access。
 */
function derivedRole(access: LibraryAccessDTO): Role {
  if (access.canManage) return "owner";
  const content = contentAccessOf(access);
  if (content.create || content.update || content.delete) return "editor";
  return "viewer";
}

interface KbGuardResult {
  role: Role;
  access: LibraryAccessDTO;
}

export async function requireKb(userId: string, kbId: string): Promise<KbGuardResult> {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: kbId, deletedAt: null } });
  if (!kb) throw new HttpError(404, "知识库不存在");
  const access = await resolveKbAccess(userId, kbId);
  if (!access.visible) {
    await shadowKb(userId, kbId, false);
    throw new HttpError(403, "无权访问该知识库");
  }
  await shadowKb(userId, kbId, true);
  return { role: derivedRole(access), access };
}

/**
 * 内容访问：一律跟随所在知识库的角色配置。
 * 知识的"能不能看/能不能改"只有这一个来源——文档级 ACL 已不再参与任何判定。
 */
export async function requireDocAccess(
  userId: string,
  docId: string,
  needEdit = false,
): Promise<{ doc: Awaited<ReturnType<typeof loadDoc>>; role: Role; canEdit: boolean; access: LibraryAccessDTO }> {
  const doc = await loadDoc(docId);
  await requireKb(userId, doc.kbId);
  const access = await resolveKbAccess(userId, doc.kbId);
  const content = contentAccessOf(access);
  const canEdit = content.update;

  const action = needEdit ? ("u" as const) : ("r" as const);
  const shadowContent = async (oldAllowed: boolean): Promise<void> => {
    if (!authzShadowActive()) return;
    // 内容授权实际挂 kb 节点、沿 kb→doc 继承：对拍 ref 对齐 kb 节点（而非 doc 自身），
    // 否则 doc 中断继承时 doc 节点判 r/u 会产生假漂移。动作仍 r/u。见 §3.3。
    await runShadowCheck(
      "requireDocAccess", userId, { resourceType: "kb", resourceId: doc.kbId }, action, oldAllowed,
    );
  };
  if (needEdit && !canEdit) {
    await shadowContent(false);
    throw new HttpError(403, "当前角色无权编辑");
  }
  await shadowContent(needEdit ? canEdit : true);
  return { doc, role: derivedRole(access), canEdit, access };
}

async function loadDoc(docId: string) {
  const doc = await prisma.kbDoc.findFirst({ where: { id: docId, deletedAt: null } });
  if (!doc) throw new HttpError(404, "文档不存在或已删除");
  return doc;
}

/**
 * 生成分享令牌：URL-safe 随机串。
 * 24 字节（192 bit）CSPRNG 熵，base64url 编码 → 32 字符，字符集 A-Za-z0-9-_（不含 +/=，URL 免转义）。
 *
 * 编码选型：base64url 而非 hex。同样的 192 bit 熵，hex 需 48 字符、base64url 只需 32 字符，
 * 24 字节恰好 8 组 3 字节，编码后无 padding。与库分享令牌（routes/bases.ts 的
 * randomBytes(24).toString("base64url")）同长同字符集，两处口径一致。
 * 用 Buffer 而非手写字母表：Node 全局可用（本项目已有 better-sqlite3 等原生依赖，
 * 且 mcp/pat/tokens.ts、domain/queryPlan 已普遍使用 Buffer 的 base64url），不引入新依赖、
 * 不新增自维护编码代码路径。
 *
 * 兼容性：只改生成、不改校验。public.ts 的 findShareRoot 按 shareToken 等值查库，
 * 对长度/字符集无任何假设，故历史上已发出的 48 字符 hex token 继续可用。
 */
export function genShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** 判断 maybeDesc 是否为 ancestorId 的后代（沿 parentId 向上走，含深度上限防环） */
export async function isDescendant(ancestorId: string, maybeDescId: string): Promise<boolean> {
  if (ancestorId === maybeDescId) return true;
  let cur: string | null = maybeDescId;
  const seen = new Set<string>();
  for (let i = 0; i < 200 && cur; i++) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break; // 数据异常自环保护
    seen.add(cur);
    const row: { parentId: string | null } | null = await prisma.kbDoc.findUnique({
      where: { id: cur },
      select: { parentId: true },
    });
    cur = row?.parentId ?? null;
  }
  return false;
}

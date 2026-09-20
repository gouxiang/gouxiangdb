// apps/api/src/routes/kb/shared.ts
// 知识库路由共享层：角色/ACL 读取、访问守卫、shadow 对拍缝、乐观锁错误、分享令牌/防环辅助。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化（URL/响应/状态码不变）。
//
// 分层说明：本文件是 kb 子路由包（index/members/docs/sharing/recycle/versions/acl）的内部
// 依赖，仅导出守卫与纯辅助；不挂任何 Hono 路由。

import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { authzShadowActive } from "../../configAuthz.js";
import { runShadowCheck } from "../../domain/authz/adapter.js";

export type Role = "owner" | "editor" | "commenter" | "viewer";

export const RANK: Record<string, number> = { owner: 4, editor: 3, commenter: 2, viewer: 1 };

export async function kbRoleOf(userId: string, kbId: string): Promise<Role | null> {
  const m = await prisma.kbMember.findUnique({
    where: { kbId_userId: { kbId, userId } },
    select: { role: true },
  });
  return (m?.role as Role) ?? null;
}

export async function docAclRoleOf(userId: string, docId: string): Promise<Role | null> {
  const a = await prisma.kbDocAcl.findUnique({
    where: { docId_userId: { docId, userId } },
    select: { role: true },
  });
  return (a?.role as Role) ?? null;
}


/**
 * M4/S3 shadow 对拍缝：仅 GX_AUTHZ_ENGINE 生效为 shadow 时跑引擎同上下文对拍；
 * off 时空操作零新增 SQL。旧决策永远为准，对拍只分类计数/脱敏日志、不改返回、不抛错。
 * 按守卫名 + kb 节点动作对拍：requireKb 只裁决成员资格(r)；处理器内的 owner-only 提级
 * （改名/删除/加成员/踢成员）对拍 manage_share，建内容对拍 c——引擎 kb owner 串恰比 editor
 * 多 manage_share、editor 持 c，与旧提级判断同口径。业务保护（不能踢 owner/自己）不属授权动作，不对拍。
 */
export async function shadowKbAction(
  guard: string,
  userId: string,
  kbId: string,
  action: "r" | "c" | "manage_share",
  oldAllowed: boolean,
): Promise<void> {
  if (!authzShadowActive()) return;
  await runShadowCheck(guard, userId, { resourceType: "kb", resourceId: kbId }, action, oldAllowed);
}

/** requireKb 成员资格对拍（kb 节点 r）。 */
async function shadowKb(userId: string, kbId: string, oldAllowed: boolean): Promise<void> {
  await shadowKbAction("requireKb", userId, kbId, "r", oldAllowed);
}

export async function requireKb(userId: string, kbId: string): Promise<{ role: Role }> {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: kbId, deletedAt: null } });
  if (!kb) throw new HttpError(404, "知识库不存在");
  const role = await kbRoleOf(userId, kbId);
  if (!role) {
    await shadowKb(userId, kbId, false);
    throw new HttpError(403, "无权访问该知识库");
  }
  await shadowKb(userId, kbId, true);
  return { role };
}

/**
 * 内容访问：知识库成员 或 单文档 ACL 授权。
 * shadow：读映射内容节点（resourceType=doc.kind，覆盖 doc/canvas）r；写映射 u；
 * 旧"取较高"结果为准，引擎对拍只观测。404（资源软删/缺失）不属授权漂移，不对拍。
 */
export async function requireDocAccess(userId: string, docId: string, needEdit = false) {
  const doc = await prisma.kbDoc.findFirst({ where: { id: docId, deletedAt: null } });
  if (!doc) throw new HttpError(404, "文档不存在或已删除");
  const kbRole = await kbRoleOf(userId, doc.kbId);
  const aclRole = await docAclRoleOf(userId, docId);
  const effective =
    kbRole && aclRole ? (RANK[kbRole]! >= RANK[aclRole]! ? kbRole : aclRole) : (kbRole ?? aclRole);
  const action = needEdit ? ("u" as const) : ("r" as const);
  const shadowContent = async (oldAllowed: boolean): Promise<void> => {
    if (!authzShadowActive()) return;
    const kind = doc.kind === "canvas" ? "canvas" : "doc";
    await runShadowCheck("requireDocAccess", userId, { resourceType: kind, resourceId: docId }, action, oldAllowed);
  };
  if (!effective) {
    await shadowContent(false);
    throw new HttpError(403, "无权访问该内容");
  }
  const canEdit = RANK[effective]! >= RANK["editor"]!;
  if (needEdit && !canEdit) {
    await shadowContent(false);
    throw new HttpError(403, "当前角色无权编辑");
  }
  await shadowContent(needEdit ? canEdit : true);
  return { doc, role: effective as Role, canEdit };
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

// 建 Base / 建知识库的编排层（REST 与 MCP 共用单一真源）。
//
// 纪律同其它领域编排：入参规整（trim/空名）+ withWriteTx；事务体在回调内只用传入 tx。
// 与路由原口径完全对齐：
//   Base：重名 409 -> base 行 -> owner member + M4 投影 -> 管理员视野 seed -> 默认表 -> nav 同步；
//   KB：重名 409 -> knowledgeBase 行（含 owner member）-> 管理员视野 seed -> nav 同步。
// create_library 动作判定（assertCanCreateLibrary）在路由/工具各自的入口做（面向会话的守卫），
// 本服务只承载「已授权后」的写入。

import { withWriteTx } from "../db.js";
import { HttpError } from "../guards.js";
import { createStarterTableTx } from "./starterTable.js";
import { syncNavFromEntitiesTx } from "./nav/sync.js";
import { syncBaseMemberTx } from "./authz/projection.js";
import { seedAdminScopeTx } from "./authz/libraryScopeSeed.js";

const BASE_DEFAULT_ICON_COLOR = "#378ADD";
const KB_DEFAULT_ICON_COLOR = "#0F6E56";

interface CreateBaseInput {
  name: string;
  iconColor?: string | null;
  icon?: string | null;
  withStarter?: boolean;
}
interface CreateKbInput {
  name: string;
  iconColor?: string | null;
  icon?: string | null;
}

/** 建库成功的创建行回执（REST DTO 与 MCP 工具共用）。 */
interface CreatedLibrary {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string;
  createdAt: string;
  createdBy: string;
}

/** 建 Base：单事务多步写；重名抛 HttpError(409)。 */
export async function createBase(input: CreateBaseInput, userId: string): Promise<CreatedLibrary> {
  const name = input.name.trim();
  if (name === "") throw new Error("数据库名不能为空");
  return withWriteTx("base.create", async (tx) => {
    const dup = await tx.base.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
    if (dup) throw new HttpError(409, `数据库名「${name}」已存在`);
    const b = await tx.base.create({
      data: {
        name,
        iconColor: input.iconColor ?? BASE_DEFAULT_ICON_COLOR,
        icon: input.icon ?? null,
        createdBy: userId,
      },
    });
    const ownerMember = await tx.member.create({ data: { baseId: b.id, userId, role: "owner" } });
    await syncBaseMemberTx(tx, { oldRowId: ownerMember.id, baseId: b.id, userId, role: "owner" });
    await seedAdminScopeTx(tx, "base", b.id, userId);
    if (input.withStarter !== false) await createStarterTableTx(tx, b.id, userId);
    await syncNavFromEntitiesTx(tx);
    return {
      id: b.id,
      name: b.name,
      icon: b.icon,
      iconColor: b.iconColor,
      createdAt: b.createdAt.toISOString(),
      createdBy: b.createdBy,
    };
  });
}

/** 建知识库：单事务多步写；重名抛 HttpError(409)。 */
export async function createKb(input: CreateKbInput, userId: string): Promise<CreatedLibrary> {
  const name = input.name.trim();
  if (name === "") throw new Error("知识库名不能为空");
  return withWriteTx("kb.create", async (tx) => {
    const dup = await tx.knowledgeBase.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
    if (dup) throw new HttpError(409, `知识库名「${name}」已存在`);
    const k = await tx.knowledgeBase.create({
      data: {
        name,
        iconColor: input.iconColor ?? KB_DEFAULT_ICON_COLOR,
        icon: input.icon ?? null,
        createdBy: userId,
        members: { create: { userId, role: "owner" } },
      },
    });
    await seedAdminScopeTx(tx, "kb", k.id, userId);
    await syncNavFromEntitiesTx(tx);
    return {
      id: k.id,
      name: k.name,
      icon: k.icon,
      iconColor: k.iconColor,
      createdAt: k.createdAt.toISOString(),
      createdBy: k.createdBy,
    };
  });
}

// MCP 实例搭建工具：base.create_base / kb.create_kb（#623）。
//
// 权限口径（与 REST POST /bases、POST /kb 一致，但不走 Hono 守卫）：
//   实例级动作 create_library（端口 canCreateLibrary，与 REST createLibraryGuard 同真源）；
//   不绑定具体资源节点（建库时目标尚不存在），故 family 归 null（不走族可见集闸门一），
//   改用 ToolMeta.gate（注册期显式门：port.canCreateLibrary() 为 true 才注册）。
// 写后回执：建库成功后创建者恒为 owner、对新库有 r（投影同事务落地），回新库 id。
//
// handler 只编排：数据写经 domain/libraryService（REST/MCP 共用），本文件不裸查 prisma、不引旧守卫。

import { createBase, createKb } from "../../domain/libraryService.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

/** base.create_base：create_library 实例动作；单事务建 Base（含默认表）。 */
export async function baseCreateBase(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  if (!(await ctx.port.canCreateLibrary())) {
    return deny("FORBIDDEN_RESOURCE", "没有新建库/知识库的权限，请联系管理员开通");
  }
  const name = String(args.name ?? "").trim();
  if (!name) return deny("INVALID_PARAMS", "数据库名不能为空");
  const created = await createBase(
    {
      name,
      iconColor: args.iconColor === undefined ? undefined : String(args.iconColor),
      icon: args.icon === undefined ? undefined : (args.icon as string | null),
      withStarter: args.withStarter === false ? false : true,
    },
    ctx.subject.userId,
  );
  return text(JSON.stringify({ ok: true, baseId: created.id, name: created.name }));
}

/** kb.create_kb：create_library 实例动作；单事务建知识库。 */
export async function kbCreateKb(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  if (!(await ctx.port.canCreateLibrary())) {
    return deny("FORBIDDEN_RESOURCE", "没有新建库/知识库的权限，请联系管理员开通");
  }
  const name = String(args.name ?? "").trim();
  if (!name) return deny("INVALID_PARAMS", "知识库名不能为空");
  const created = await createKb(
    {
      name,
      iconColor: args.iconColor === undefined ? undefined : String(args.iconColor),
      icon: args.icon === undefined ? undefined : (args.icon as string | null),
    },
    ctx.subject.userId,
  );
  return text(JSON.stringify({ ok: true, kbId: created.id, name: created.name }));
}

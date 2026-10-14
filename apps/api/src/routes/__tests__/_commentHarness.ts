// 评论增强端到端测试的共享夹具：真迁移临时库 + 真 records/attachments 路由 + 真落盘。
//
// 在 _realApp 的「records」装配基础上额外挂 /attachments（评论附件通道用），并补上本专题
// 要用的用户/成员/记录/附件辅助。身份注入（vi.mock auth.js）由测试文件持有可变 currentUserId
// （与 _attachmentHarness 同款纪律）。
//
// 评论者身份构造（忠实生产原语，不裸拼策略）：
//   · 一枚 viewer 角色 × 库视野（visible=1）-> 投影 base 节点 enter + 表节点 r，
//     使 access.visible=true、requireCanView 通过，但 canEditData=false；
//   · 一条 members(role=commenter) 行经生产投影 syncBaseMemberTx -> base 节点 user 策略
//     "comment,r"（无 edit_data），使 requireCanComment 的纯评论档放行、requireCanEditData 拒绝。
//   第二代 scope 模型里 comment 只随 c/u/d 投影（必派生 edit_data），故「只评论不可编辑」的
//   唯一真实来源就是库节点上的 comment 授予——这正是评论守要承接的身份。

import { Hono } from "hono";
import { setupHarness } from "./_realApp.js";
import { rebuildScopePoliciesTx } from "../../domain/authz/scopeDoubleWrite.js";
import { syncBaseMemberTx } from "../../domain/authz/projection.js";

let roleSeq = 0;

export interface CommentHarness extends Awaited<
  ReturnType<typeof setupHarness>
> {
  app: Hono;
  /** 仅可见 + 仅评论（无 edit_data）的用户。 */
  makeCommentOnlyUser: (
    id: string,
    displayName: string,
    baseId: string,
  ) => Promise<void>;
  /** 仅可见（enter）无评论权的用户。 */
  makeViewerUser: (
    id: string,
    displayName: string,
    baseId: string,
  ) => Promise<void>;
  /** 直接插一条 members 行（@mention 成员校验用，不投影策略）。 */
  addMember: (baseId: string, userId: string, role?: string) => Promise<void>;
  /** 建一张表并插一条记录，返回记录 id。 */
  makeRecordInBase: (baseId: string) => Promise<string>;
  /** multipart 上传附件。 */
  uploadAttachment: (
    files: Array<{ name: string; type: string; content: string | Buffer }>,
    meta: Record<string, string>,
  ) => Promise<Response>;
}

export async function setupCommentHarness(
  prefix = "gx-comments-",
): Promise<CommentHarness> {
  const base = await setupHarness(prefix, "records");
  const prisma = base.prisma;

  const [guardsMod, recordsMod, attachmentsMod] = await Promise.all([
    import("../../guards.js"),
    import("../records.js"),
    import("../attachments.js"),
  ]);
  const app = new Hono();
  app.route("/records", recordsMod.records);
  app.route("/attachments", attachmentsMod.attachments);
  app.onError((err, c) => guardsMod.errorResponse(c, err));

  async function createUser(id: string, displayName: string): Promise<void> {
    await prisma.user.create({
      data: {
        id,
        email: `${id}-${roleSeq}@example.com`,
        displayName,
        passwordHash: "x",
      },
    });
  }

  /** 给用户配一枚仅 visible 的自定义角色并重建节点投影（base enter + 表 r，无 edit_data/comment）。 */
  async function grantViewerScope(id: string, baseId: string): Promise<string> {
    const roleId = `role_test_view_${++roleSeq}`;
    await prisma.role.create({
      data: {
        id: roleId,
        workspaceId: "ws_default",
        name: `只读 ${roleSeq}`,
        isSystem: 0,
        permissions: "[]",
      },
    });
    await prisma.roleAssignment.create({
      data: {
        roleId,
        subjectType: "user",
        subjectId: id,
        scopeType: "workspace",
        createdBy: "seed",
      },
    });
    await prisma.roleLibraryScope.create({
      data: {
        roleId,
        libraryKind: "base",
        libraryId: baseId,
        canManage: 0,
        visible: 1,
        canShare: 0,
      },
    });
    const saved = await prisma.roleLibraryScope.findMany({ where: { roleId } });
    await rebuildScopePoliciesTx(
      prisma,
      roleId,
      saved.map((r) => ({
        roleId: r.roleId,
        libraryKind: r.libraryKind,
        libraryId: r.libraryId,
        canManage: r.canManage,
        visible: r.visible,
        canShare: r.canShare,
        config: r.config,
      })),
      "seed",
    );
    return roleId;
  }

  async function makeViewerUser(
    id: string,
    displayName: string,
    baseId: string,
  ): Promise<void> {
    await createUser(id, displayName);
    await grantViewerScope(id, baseId);
  }

  async function makeCommentOnlyUser(
    id: string,
    displayName: string,
    baseId: string,
  ): Promise<void> {
    await createUser(id, displayName);
    await grantViewerScope(id, baseId); // enter + access.visible（无 edit_data）
    // 生产投影：members(commenter) -> base 节点 user 策略 "comment,r"。
    const member = await prisma.member.create({
      data: { baseId, userId: id, role: "commenter" },
    });
    await syncBaseMemberTx(prisma, {
      oldRowId: member.id,
      baseId,
      userId: id,
      role: "commenter",
    });
  }

  async function addMember(
    baseId: string,
    userId: string,
    role = "viewer",
  ): Promise<void> {
    await prisma.member.create({ data: { baseId, userId, role } });
  }

  // 同一 base 内表名唯一：每个 base 只建一张表并复用，多条记录挂到该表。
  const tableIdByBase = new Map<string, string>();

  async function makeRecordInBase(baseId: string): Promise<string> {
    let tableId = tableIdByBase.get(baseId);
    if (!tableId) {
      const t = await base.makeTable(baseId, "T");
      tableId = t.id;
      tableIdByBase.set(baseId, tableId);
    }
    const rec = await prisma.record.create({
      data: { tableId, fields: "{}", createdBy: "u1", updatedBy: "u1" },
    });
    return rec.id;
  }

  async function uploadAttachment(
    files: Array<{ name: string; type: string; content: string | Buffer }>,
    meta: Record<string, string>,
  ): Promise<Response> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(meta)) fd.append(k, v);
    for (const f of files) {
      const body =
        typeof f.content === "string" ? f.content : new Uint8Array(f.content);
      fd.append("file", new File([body], f.name, { type: f.type }));
    }
    return app.request("/attachments", { method: "POST", body: fd });
  }

  return {
    ...base,
    app,
    makeCommentOnlyUser,
    makeViewerUser,
    addMember,
    makeRecordInBase,
    uploadAttachment,
  };
}

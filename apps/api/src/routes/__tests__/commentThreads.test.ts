// 评论两级回复 / 倒序 / 纯附件 / @提及 / 级联删除 端到端（真 app、真迁移、真路由）。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupCommentHarness, type CommentHarness } from "./_commentHarness.js";

const OWNER = "u1";
const COMMENTER = "uc";
const VIEWER = "uv";
const OTHER_MEMBER = "uo";

let currentUserId: string | null = OWNER;
vi.mock("../../auth.js", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../../auth.js");
  return { ...actual, getUserId: () => Promise.resolve(currentUserId) };
});

let h: CommentHarness;
let baseId: string;
let recordId: string;

beforeAll(async () => {
  h = await setupCommentHarness("gx-comment-threads-");
  baseId = await h.makeBase("评论库");
  recordId = await h.makeRecordInBase(baseId);
  await h.makeCommentOnlyUser(COMMENTER, "纯评论者", baseId);
  await h.makeViewerUser(VIEWER, "只读成员", baseId);
  await h.prisma.user.create({
    data: {
      id: OTHER_MEMBER,
      email: "uo@example.com",
      displayName: "被提及人",
      passwordHash: "x",
    },
  });
  await h.addMember(baseId, OTHER_MEMBER, "editor");
}, 120_000);

afterAll(async () => {
  await h.teardown();
});

async function api(
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  return h.app.request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (res: Response): Promise<any> => res.json();

/** 直接插一条「旧风格」评论：无 parentId/附件/@，裸列默认值（验迁移兼容）。 */
async function insertLegacyComment(
  rid: string,
  body: string,
  userId = OWNER,
): Promise<string> {
  // 新列全部省略：parentId/replyToUserId 可空、attachments/mentions 有 DB 默认 '[]'，
  // 用以验证旧风格写入与迁移默认值（Prisma 类型允许省略，默认值由数据库落定）。
  const row = await h.prisma.comment.create({
    data: { recordId: rid, userId, body },
  });
  return row.id;
}

describe("GET 评论：旧数据兼容 + 倒序分组", () => {
  it("旧风格评论（无附件无 parent）：attachments=[]、mentions=[]、parentId=null，DTO 形状齐全", async () => {
    await insertLegacyComment(recordId, "旧评论");
    const res = await api("GET", `/records/${recordId}/comments`);
    expect(res.status).toBe(200);
    const { comments } = await json(res);
    const legacy = comments.find((c: any) => c.body === "旧评论");
    expect(legacy).toMatchObject({
      recordId,
      userId: OWNER,
      parentId: null,
      replyToUserId: null,
      replyToDisplayName: null,
      body: "旧评论",
      attachments: [],
      mentions: [],
    });
    expect(typeof legacy.displayName).toBe("string");
    expect(
      legacy.avatarUrl === null || typeof legacy.avatarUrl === "string",
    ).toBe(true);
    expect(typeof legacy.createdAt).toBe("string");
    // 根评论内嵌空回复数组。
    expect(legacy.replies).toEqual([]);
  });

  it("三条根评论按 createdAt 倒序返回", async () => {
    const r = await h.makeRecordInBase(baseId);
    await insertLegacyComment(r, "根一");
    await insertLegacyComment(r, "根二");
    await insertLegacyComment(r, "根三");
    const { comments } = await json(await api("GET", `/records/${r}/comments`));
    expect(comments.map((c: any) => c.body)).toEqual(["根三", "根二", "根一"]);
  });
});

describe("POST/GET 两级回复", () => {
  it("回复挂到根且按时间升序内嵌；回复回复被 400；缺被回复人 400", async () => {
    const rootId = await insertLegacyComment(recordId, "讨论根");

    // 第一条回复：owner 回复根作者（=owner 自己，合法参与者）。
    const r1 = await api("POST", `/records/${recordId}/comments`, {
      body: "回复一",
      parentId: rootId,
      replyToUserId: OWNER,
    });
    expect(r1.status).toBe(201);

    // 纯评论者身份回复根作者。
    currentUserId = COMMENTER;
    const r2 = await api("POST", `/records/${recordId}/comments`, {
      body: "回复二",
      parentId: rootId,
      replyToUserId: OWNER,
    });
    expect(r2.status).toBe(201);
    currentUserId = OWNER;

    // 回复升序。
    const { comments } = await json(
      await api("GET", `/records/${recordId}/comments`),
    );
    const root = comments.find((c: any) => c.id === rootId);
    expect(root.replies.map((x: any) => x.body)).toEqual(["回复一", "回复二"]);
    expect(root.replies[1]).toMatchObject({
      parentId: rootId,
      replyToUserId: OWNER,
      replyToDisplayName: root.displayName,
    });

    // 两级封顶：拿一条回复当 parent -> 400。
    const replyId = root.replies[0].id;
    const nested = await api("POST", `/records/${recordId}/comments`, {
      body: "三级",
      parentId: replyId,
      replyToUserId: OWNER,
    });
    expect(nested.status).toBe(400);

    // 缺 replyToUserId -> 400。
    const noTarget = await api("POST", `/records/${recordId}/comments`, {
      body: "无目标",
      parentId: rootId,
    });
    expect(noTarget.status).toBe(400);

    // 被回复人不是该 thread 参与者 -> 400。
    const outsider = await api("POST", `/records/${recordId}/comments`, {
      body: "串台",
      parentId: rootId,
      replyToUserId: "u_not_in_thread",
    });
    expect(outsider.status).toBe(400);

    // 回复别的记录的根 -> 400。
    const otherRec = await h.makeRecordInBase(baseId);
    const otherRoot = await insertLegacyComment(otherRec, "别的根");
    const cross = await api("POST", `/records/${recordId}/comments`, {
      body: "跨记录",
      parentId: otherRoot,
      replyToUserId: OWNER,
    });
    expect(cross.status).toBe(400);
  });

  it("被回复人可以是已存在回复的作者（thread 参与者）", async () => {
    const rootId = await insertLegacyComment(recordId, "另一根");
    currentUserId = COMMENTER;
    await api("POST", `/records/${recordId}/comments`, {
      body: "评论者先回",
      parentId: rootId,
      replyToUserId: OWNER,
    });
    // owner 回复评论者（评论者已在此 thread）。
    currentUserId = OWNER;
    const ok = await api("POST", `/records/${recordId}/comments`, {
      body: "回应评论者",
      parentId: rootId,
      replyToUserId: COMMENTER,
    });
    expect(ok.status).toBe(201);
    expect((await json(ok)).comment.replyToDisplayName).toBe("纯评论者");
  });
});

describe("POST 纯附件评论与空内容校验", () => {
  it("body 空 + attachmentIds 成功（纯图片）；body 与附件都空 -> 400", async () => {
    const rec = await h.makeRecordInBase(baseId);
    // owner 通过评论通道上传一个附件，绑定本记录。
    const up = await h.uploadAttachment(
      [
        {
          name: "pic.png",
          type: "image/png",
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
      { baseId, recordId: rec, purpose: "comment" },
    );
    expect(up.status).toBe(201);
    const attId = (await json(up)).files[0].id;

    const pure = await api("POST", `/records/${rec}/comments`, {
      attachmentIds: [attId],
    });
    expect(pure.status).toBe(201);
    const created = (await json(pure)).comment;
    expect(created.body).toBe("");
    expect(created.attachments).toHaveLength(1);
    expect(created.attachments[0]).toMatchObject({
      id: attId,
      url: `/api/attachments/${attId}/content`,
    });

    const empty = await api("POST", `/records/${rec}/comments`, {
      body: "   ",
    });
    expect(empty.status).toBe(400);
    expect((await json(empty)).error).toContain("评论内容不能为空");
  });
});

describe("POST @提及", () => {
  it("@ 成员成功并返回展示名；@ 非成员 400（fail-closed）", async () => {
    const rec = await h.makeRecordInBase(baseId);
    const ok = await api("POST", `/records/${rec}/comments`, {
      body: "hi",
      mentionIds: [OTHER_MEMBER],
    });
    expect(ok.status).toBe(201);
    expect((await json(ok)).comment.mentions).toEqual([
      { userId: OTHER_MEMBER, displayName: "被提及人" },
    ]);

    const bad = await api("POST", `/records/${rec}/comments`, {
      body: "x",
      mentionIds: ["u_not_a_member"],
    });
    expect(bad.status).toBe(400);
  });
});

describe("DELETE 级联", () => {
  it("删根评论其回复一并消失；只解除附件引用不删附件", async () => {
    const rec = await h.makeRecordInBase(baseId);
    const rootId = await insertLegacyComment(rec, "待删根");
    const up = await h.uploadAttachment(
      [{ name: "a.txt", type: "text/plain", content: "keep-me" }],
      { baseId, recordId: rec, purpose: "comment" },
    );
    const attId = (await json(up)).files[0].id;
    await api("POST", `/records/${rec}/comments`, {
      body: "带附件回复",
      parentId: rootId,
      replyToUserId: OWNER,
      attachmentIds: [attId],
    });

    const before = await json(await api("GET", `/records/${rec}/comments`));
    expect(
      before.comments.find((c: any) => c.id === rootId).replies,
    ).toHaveLength(1);

    const del = await api("DELETE", `/records/comments/${rootId}`);
    expect(del.status).toBe(200);

    const after = await json(await api("GET", `/records/${rec}/comments`));
    expect(after.comments.find((c: any) => c.id === rootId)).toBeUndefined();

    // 附件行仍在（删评论不删附件）。
    const att = await h.prisma.attachment.findUnique({ where: { id: attId } });
    expect(att).not.toBeNull();
    expect(att!.deletedAt).toBeNull();
  });

  it("非本人且非 owner/creator 不能删他人评论 -> 403", async () => {
    const rec = await h.makeRecordInBase(baseId);
    const rootId = await insertLegacyComment(rec, "owner 的评论");
    currentUserId = COMMENTER;
    const denied = await api("DELETE", `/records/comments/${rootId}`);
    expect(denied.status).toBe(403);
    currentUserId = OWNER;
  });
});

describe("权限：评论者 vs 只读", () => {
  it("纯评论者可发评论，只读成员 403；不存在记录 404", async () => {
    currentUserId = COMMENTER;
    const ok = await api("POST", `/records/${recordId}/comments`, {
      body: "评论者发言",
    });
    expect(ok.status).toBe(201);

    currentUserId = VIEWER;
    const denied = await api("POST", `/records/${recordId}/comments`, {
      body: "只读发言",
    });
    expect(denied.status).toBe(403);
    currentUserId = OWNER;

    const notFound = await api("GET", "/records/rec_does_not_exist/comments");
    expect(notFound.status).toBe(404);
  });
});

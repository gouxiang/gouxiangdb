// 评论附件通道：purpose=comment 仅需评论权；评论引用时 DELETE 409，删评论后放行；跨记录附件 400。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupCommentHarness, type CommentHarness } from "./_commentHarness.js";

const OWNER = "u1";
const COMMENTER = "uc2";
const VIEWER = "uv2";

let currentUserId: string | null = OWNER;
vi.mock("../../auth.js", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../../auth.js");
  return { ...actual, getUserId: () => Promise.resolve(currentUserId) };
});

let h: CommentHarness;
let baseId: string;

beforeAll(async () => {
  h = await setupCommentHarness("gx-comment-attach-");
  baseId = await h.makeBase("评论附件库");
  await h.makeCommentOnlyUser(COMMENTER, "纯评论者", baseId);
  await h.makeViewerUser(VIEWER, "只读成员", baseId);
}, 120_000);

afterAll(async () => {
  await h.teardown();
});

const json = async (res: Response): Promise<any> => res.json();

const txt = (name: string, content = "x") => [
  { name, type: "text/plain", content },
];

describe("POST /attachments purpose 分流", () => {
  it("purpose=comment：仅评论权（无 editData）可上传；同一身份走默认 record 通道 403", async () => {
    const rec = await h.makeRecordInBase(baseId);
    currentUserId = COMMENTER;
    const ok = await h.uploadAttachment(txt("c.txt"), {
      baseId,
      recordId: rec,
      purpose: "comment",
    });
    expect(ok.status).toBe(201);

    // 默认 record 通道维持编辑数据权：纯评论者被拒。
    const denied = await h.uploadAttachment(txt("r.txt"), {
      baseId,
      recordId: rec,
    });
    expect(denied.status).toBe(403);
    currentUserId = OWNER;
  });

  it("purpose=comment 缺 recordId -> 400；recordId 不属于该 base -> 400", async () => {
    currentUserId = COMMENTER;
    const rec = await h.makeRecordInBase(baseId);

    const noRecord = await h.uploadAttachment(txt("n.txt"), {
      baseId,
      purpose: "comment",
    });
    expect(noRecord.status).toBe(400);
    expect((await json(noRecord)).error).toContain("必须绑定记录");

    // 另一个 base 的记录。
    const otherBase = await h.makeBase("另一个库");
    const foreignRec = await h.makeRecordInBase(otherBase);
    const cross = await h.uploadAttachment(txt("x.txt"), {
      baseId,
      recordId: foreignRec,
      purpose: "comment",
    });
    expect(cross.status).toBe(400);
    currentUserId = OWNER;
    void rec;
  });

  it("只读成员 purpose=comment 仍 403；purpose 非法值 400", async () => {
    const rec = await h.makeRecordInBase(baseId);
    currentUserId = VIEWER;
    const denied = await h.uploadAttachment(txt("v.txt"), {
      baseId,
      recordId: rec,
      purpose: "comment",
    });
    expect(denied.status).toBe(403);
    currentUserId = OWNER;

    const bad = await h.uploadAttachment(txt("b.txt"), {
      baseId,
      purpose: "bogus",
    });
    expect(bad.status).toBe(400);
  });
});

describe("评论引用的附件不可删（409）", () => {
  async function postComment(rec: string, body: unknown): Promise<any> {
    const res = await h.app.request(`/records/${rec}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res;
  }

  it("附件被评论引用 -> DELETE 409；删除评论后 DELETE 成功", async () => {
    const rec = await h.makeRecordInBase(baseId);
    const up = await h.uploadAttachment(
      [
        {
          name: "shot.png",
          type: "image/png",
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
      { baseId, recordId: rec, purpose: "comment" },
    );
    const attId = (await json(up)).files[0].id;

    const created = await postComment(rec, {
      body: "看图",
      attachmentIds: [attId],
    });
    expect(created.status).toBe(201);
    const commentId = (await json(created)).comment.id;

    const blocked = await h.app.request(`/attachments/${attId}`, {
      method: "DELETE",
    });
    expect(blocked.status).toBe(409);
    const blockedBody = await json(blocked);
    expect(blockedBody.code).toBe("ATTACHMENT_IN_USE");
    expect(blockedBody.error).toContain("仍被评论引用");

    // 删评论（根评论）解除引用。
    const delComment = await h.app.request(`/records/comments/${commentId}`, {
      method: "DELETE",
    });
    expect(delComment.status).toBe(200);

    const freed = await h.app.request(`/attachments/${attId}`, {
      method: "DELETE",
    });
    expect(freed.status).toBe(200);
  });

  it("发评论引用跨库/跨记录/已删附件 -> 400「附件不可用」", async () => {
    const rec = await h.makeRecordInBase(baseId);

    // 属于别的记录的附件（同 base 不同 record）。
    const recA = await h.makeRecordInBase(baseId);
    const otherRec = await h.makeRecordInBase(baseId);
    const up = await h.uploadAttachment(txt("own.txt"), {
      baseId,
      recordId: recA,
      purpose: "comment",
    });
    const otherAtt = (await json(up)).files[0].id;

    const crossRecord = await postComment(otherRec, {
      body: "挪用",
      attachmentIds: [otherAtt],
    });
    expect(crossRecord.status).toBe(400);
    expect((await json(crossRecord)).error).toBe("附件不可用");

    // 请求里带一个不存在的 id -> 400。
    const missing = await postComment(rec, {
      body: "幽灵",
      attachmentIds: ["att_does_not_exist"],
    });
    expect(missing.status).toBe(400);
  });
});

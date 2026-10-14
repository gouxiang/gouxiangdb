// commentThreads 纯函数单测：JSON 容错解析 + 两级分组/倒序/孤儿平铺/DTO 回退。

import { describe, expect, it } from "vitest";
import {
  buildCommentThreads,
  hydrateCommentThreads,
  hydrateSingleComment,
  parseJsonIdArray,
  type CommentDataRow,
} from "../commentThreads.js";

function row(p: Partial<CommentDataRow> & { id: string }): CommentDataRow {
  const t = p.createdAt ?? new Date("2026-10-14T00:00:00Z");
  return {
    recordId: "rec1",
    userId: "u1",
    body: "",
    parentId: null,
    replyToUserId: null,
    attachments: "[]",
    mentions: "[]",
    createdAt: t,
    updatedAt: t,
    ...p,
  };
}

const maps = {
  users: new Map([
    ["u1", { id: "u1", displayName: "甲", avatarUrl: "/a1.png" }],
    ["u2", { id: "u2", displayName: "乙", avatarUrl: null }],
  ]),
  attachments: new Map([
    ["att1", { id: "att1", name: "a.png", size: 3, mime: "image/png" }],
  ]),
};

describe("parseJsonIdArray", () => {
  it("正常数组保序；坏 JSON/非数组/非字符串元素容错", () => {
    expect(parseJsonIdArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseJsonIdArray("")).toEqual([]);
    expect(parseJsonIdArray("not json")).toEqual([]);
    expect(parseJsonIdArray('{"x":1}')).toEqual([]);
    expect(parseJsonIdArray('["a",1,null,"b"]')).toEqual(["a", "b"]);
  });
});

describe("buildCommentThreads", () => {
  it("根倒序、回复升序内嵌", () => {
    const r1 = row({
      id: "r1",
      body: "根早",
      createdAt: new Date("2026-10-14T01:00:00Z"),
    });
    const r2 = row({
      id: "r2",
      body: "根晚",
      createdAt: new Date("2026-10-14T03:00:00Z"),
    });
    const c1 = row({
      id: "c1",
      parentId: "r1",
      replyToUserId: "u1",
      body: "回晚",
      createdAt: new Date("2026-10-14T04:00:00Z"),
      userId: "u2",
    });
    const c2 = row({
      id: "c2",
      parentId: "r1",
      replyToUserId: "u1",
      body: "回早",
      createdAt: new Date("2026-10-14T02:00:00Z"),
      userId: "u2",
    });
    const out = buildCommentThreads([r1, c1, c2, r2], maps);
    expect(out.map((c) => c.body)).toEqual(["根晚", "根早"]);
    const early = out.find((c) => c.id === "r1")!;
    expect(early.replies?.map((c) => c.body)).toEqual(["回早", "回晚"]);
  });

  it("孤儿回复（parent 根不存在）平铺进根列表，不带 replies", () => {
    const root = row({
      id: "r1",
      body: "根",
      createdAt: new Date("2026-10-14T01:00:00Z"),
    });
    const orphan = row({
      id: "o1",
      parentId: "missing",
      body: "孤儿",
      createdAt: new Date("2026-10-14T02:00:00Z"),
    });
    const out = buildCommentThreads([root, orphan], maps);
    expect(out.map((c) => c.body)).toEqual(["孤儿", "根"]);
    expect(out[0]!.replies).toBeUndefined();
  });

  it("DTO 回退：作者缺失 displayName=''；附件找不到跳过；@ 取不到展示名整条丢弃；replyTo 缺失名=null", () => {
    const r = row({
      id: "r1",
      userId: "ghost",
      attachments: '["att1","attGone"]',
      mentions: '["u1","ghostMention"]',
    });
    const out = buildCommentThreads([r], maps);
    expect(out[0]!.displayName).toBe("");
    expect(out[0]!.avatarUrl).toBeNull();
    expect(out[0]!.attachments.map((a) => a.id)).toEqual(["att1"]);
    expect(out[0]!.mentions).toEqual([{ userId: "u1", displayName: "甲" }]);

    const reply = row({
      id: "c1",
      parentId: "r1",
      userId: "u2",
      replyToUserId: "ghostTarget",
      body: "回",
    });
    const withReply = buildCommentThreads([r, reply], maps);
    const nested = withReply.find((c) => c.id === "r1")!.replies![0]!;
    expect(nested.replyToUserId).toBe("ghostTarget");
    expect(nested.replyToDisplayName).toBeNull();
  });
});

describe("hydrate*（假 client）", () => {
  function fakeClient() {
    return {
      user: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in
            .filter((id) => maps.users.has(id))
            .map((id) => maps.users.get(id)!),
      },
      attachment: {
        findMany: async ({
          where,
        }: {
          where: { id: { in: string[] }; deletedAt: null };
        }) =>
          where.id.in
            .filter((id) => maps.attachments.has(id))
            .map((id) => maps.attachments.get(id)!),
      },
    };
  }

  it("hydrateCommentThreads 批量组装；空输入返回空数组", async () => {
    expect(await hydrateCommentThreads(fakeClient(), [])).toEqual([]);
    const r = row({ id: "r1", body: "根", mentions: '["u2"]' });
    const out = await hydrateCommentThreads(fakeClient(), [r]);
    expect(out[0]!.mentions).toEqual([{ userId: "u2", displayName: "乙" }]);
  });

  it("hydrateSingleComment 组装单条（POST 返回口径），url 为 content 相对路径", async () => {
    const r = row({ id: "r1", body: "", attachments: '["att1"]' });
    const dto = await hydrateSingleComment(fakeClient(), r);
    expect(dto.attachments[0]!.url).toBe("/api/attachments/att1/content");
    expect(dto.replies).toBeUndefined();
  });
});

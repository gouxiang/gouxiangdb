// apps/web/src/features/comments/logic.test.ts
// 评论纯函数决策层单测（node 环境，无 jsdom）。
// 覆盖：@ 触发/候选/插入/提及反推/正文分段、附件内联（排除 svg）、
// 拖放粘贴取文件、两级排序计数、payload 构造、发送门控、回复目标。

import { describe, expect, it } from "vitest";
import type { CommentDTO } from "@gx/shared-types";
import type { RosterMember } from "../contacts/member-roster";
import {
  activeMention,
  applyMention,
  bodySegments,
  buildCommentPayload,
  canSubmit,
  collectFiles,
  collectPastedImages,
  isInlineImageAttachment,
  mentionCandidates,
  mentionIdsFromPicked,
  replyTargetOf,
} from "./logic";

const member = (
  id: string,
  displayName: string,
  email = `${id}@x.com`,
): RosterMember => ({
  id,
  displayName,
  email,
  avatarUrl: null,
});

const members: RosterMember[] = [
  member("u1", "张三", "zhangsan@x.com"),
  member("u2", "李四", "lisi@x.com"),
  member("u3", "王五", "wangwu@x.com"),
];

describe("activeMention：光标处 @ 触发判定", () => {
  it("空白后输入 @ 即触发，query 为已输入字", () => {
    expect(activeMention("hello @张", "hello @张".length)).toEqual({
      start: 6,
      query: "张",
    });
  });
  it("行首 @ 触发（start=0）", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("邮箱场景 a@b 不触发（@ 前是普通字符）", () => {
    expect(activeMention("a@b", 3)).toBeNull();
  });
  it("@ 后出现空白则结束触发", () => {
    expect(activeMention("@张三 你", "@张三 你".length)).toBeNull();
  });
  it("第二个 @ 出现时只认最后一个", () => {
    expect(activeMention("@a @b", "@a @b".length)).toEqual({
      start: 3,
      query: "b",
    });
  });
  it("光标不在末尾也按光标位置判定", () => {
    const text = "@李 rest";
    // 光标在 "@李" 之后（index 2）
    expect(activeMention(text, 2)).toEqual({ start: 0, query: "李" });
  });
  it("越界 caret 被 clamp，不抛错", () => {
    expect(activeMention("@", 99)).toEqual({ start: 0, query: "" });
  });
});

describe("mentionCandidates：成员过滤", () => {
  it("按中文名包含过滤", () => {
    expect(mentionCandidates(members, "张").map((m) => m.id)).toEqual(["u1"]);
  });
  it("支持邮箱本地名匹配", () => {
    expect(mentionCandidates(members, "wangwu").map((m) => m.id)).toEqual([
      "u3",
    ]);
  });
  it("空 query 返回全部并截断到 limit", () => {
    expect(mentionCandidates(members, "", 2)).toHaveLength(2);
  });
  it("大小写不敏感", () => {
    expect(mentionCandidates(members, "ZHANG").map((m) => m.id)).toEqual([
      "u1",
    ]);
  });
});

describe("applyMention：插入展示名", () => {
  it("用 @展示名 + 空格 替换 @query，并返回新光标", () => {
    const r = applyMention("hi @张 ok", 5, 3, "张三");
    expect(r.text).toBe("hi @张三  ok");
    expect(r.text.slice(0, r.caret)).toBe("hi @张三 ");
  });
});

describe("mentionIdsFromPicked / bodySegments", () => {
  it("正文里仍存在 @名字 才保留提及 id，去重", () => {
    const picked = [
      { id: "u1", name: "张三" },
      { id: "u2", name: "李四" },
    ];
    // 正文删掉了 @李四
    expect(mentionIdsFromPicked("问 @张三 一下", picked)).toEqual(["u1"]);
  });
  it("正文分段把提及切成 mention 段，其余 text 段", () => {
    const segs = bodySegments("@张三 请看", [
      { userId: "u1", displayName: "张三" },
    ]);
    expect(segs.map((s) => s.type)).toEqual(["mention", "text"]);
    expect(segs[0]).toMatchObject({
      type: "mention",
      text: "@张三",
      userId: "u1",
    });
  });
  it("长名字优先匹配，避免短名抢先", () => {
    const segs = bodySegments("@张三丰 好", [
      { userId: "a", displayName: "张三" },
      { userId: "b", displayName: "张三丰" },
    ]);
    expect(segs[0]).toMatchObject({ text: "@张三丰", userId: "b" });
  });
  it("正文匹配不到任何提及快照时不凭空高亮", () => {
    const segs = bodySegments("普通文本", [
      { userId: "a", displayName: "张三" },
    ]);
    expect(segs).toEqual([{ type: "text", text: "普通文本" }]);
  });
  it("空正文返回空数组", () => {
    expect(bodySegments("", [])).toEqual([]);
  });
});

describe("isInlineImageAttachment：svg 强制不内联", () => {
  it("jpg/png 内联", () => {
    expect(isInlineImageAttachment({ name: "a.jpg" })).toBe(true);
    expect(isInlineImageAttachment({ name: "a.png", mime: "image/png" })).toBe(
      true,
    );
  });
  it("扩展名 svg 不内联（即使 mime 是 svg）", () => {
    expect(
      isInlineImageAttachment({ name: "x.svg", mime: "image/svg+xml" }),
    ).toBe(false);
  });
  it("仅 mime 声明 svg 也不内联", () => {
    expect(isInlineImageAttachment({ name: "x", mime: "image/svg+xml" })).toBe(
      false,
    );
  });
  it("pdf/docx 不内联", () => {
    expect(isInlineImageAttachment({ name: "a.pdf" })).toBe(false);
    expect(isInlineImageAttachment({ name: "a.docx" })).toBe(false);
  });
});

function fakeFile(name: string, type: string): File {
  // node 环境 File 可能缺失，用最小结构 + as File（collectFiles 只读 length/索引，不调方法）
  return { name, type } as unknown as File;
}

describe("collectFiles / collectPastedImages", () => {
  it("优先从 items（kind=file/getAsFile）取", () => {
    const f = fakeFile("p.png", "image/png");
    const out = collectFiles({
      items: [
        { kind: "file", getAsFile: () => f },
        { kind: "string", getAsFile: () => null },
      ],
      files: [],
    });
    expect(out).toEqual([f]);
  });
  it("items 为空时退化到 files", () => {
    const f = fakeFile("a.pdf", "application/pdf");
    expect(collectFiles({ files: [f] })).toEqual([f]);
  });
  it("null/undefined 载体返回空数组，不抛错", () => {
    expect(collectFiles(null)).toEqual([]);
    expect(collectFiles(undefined)).toEqual([]);
  });
  it("粘贴只收图片，过滤掉 pdf", () => {
    const out = collectPastedImages({
      files: [
        fakeFile("p.png", "image/png"),
        fakeFile("d.pdf", "application/pdf"),
        fakeFile("s.svg", "image/svg+xml"),
      ],
    });
    expect(out.map((f) => f.name)).toEqual(["p.png"]);
  });
});

// ====================== 发送载荷 / 门控 / 回复目标 ======================

const c = (o: Partial<CommentDTO> & { id: string }): CommentDTO =>
  ({
    recordId: "r1",
    userId: "u",
    displayName: "名",
    avatarUrl: null,
    body: "",
    attachments: [],
    mentions: [],
    parentId: null,
    replyToUserId: null,
    replyToDisplayName: null,
    replies: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as CommentDTO;

describe("buildCommentPayload / canSubmit / replyTargetOf", () => {
  it("trim 正文、去空字段，纯附件评论不带 body", () => {
    const p = buildCommentPayload({
      body: "   ",
      attachmentIds: ["a1", "", "a2"],
    });
    expect(p.body).toBeUndefined();
    expect(p.attachmentIds).toEqual(["a1", "a2"]);
  });
  it("回复同时带 parentId 与 replyToUserId", () => {
    const p = buildCommentPayload({
      body: "hi",
      parentId: "root1",
      replyToUserId: "u9",
    });
    expect(p.parentId).toBe("root1");
    expect(p.replyToUserId).toBe("u9");
  });
  it("非回复不出现 parentId", () => {
    expect(buildCommentPayload({ body: "x" }).parentId).toBeUndefined();
  });
  it("有 parentId 无 replyToUserId 时不臆造", () => {
    const p = buildCommentPayload({ body: "x", parentId: "root1" });
    expect(p.replyToUserId).toBeUndefined();
  });

  it("空内容禁发；有就绪附件可发；上传中禁发", () => {
    expect(canSubmit("   ", 0, 0)).toBe(false);
    expect(canSubmit("字", 0, 0)).toBe(true);
    expect(canSubmit("   ", 1, 0)).toBe(true);
    expect(canSubmit("字", 1, 1)).toBe(false);
  });

  it("点回复：根评论→挂自己；回复→挂其根且被回复人是该回复作者", () => {
    const root = c({ id: "root", userId: "u-root", displayName: "楼主" });
    const rep = c({
      id: "rep",
      userId: "u-rep",
      displayName: "回者",
      parentId: "root",
    });
    expect(replyTargetOf(root)).toEqual({
      rootId: "root",
      userId: "u-root",
      displayName: "楼主",
    });
    expect(replyTargetOf(rep)).toEqual({
      rootId: "root",
      userId: "u-rep",
      displayName: "回者",
    });
  });
});

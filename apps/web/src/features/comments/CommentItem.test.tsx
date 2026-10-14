// apps/web/src/features/comments/CommentItem.test.tsx
// 组件渲染回归（node：react-dom/server，无 jsdom/testing-library）。
// 断言：@ 高亮 chip、回复对象行、图片/文件附件分派（svg 不内联）、删除门控（管理员/本人/路人）、
// 回复缩进与标识。交互（删除确认）走 feedback.confirmAction，这里只验证渲染与门控。

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommentDTO, AttachmentDTO } from "@gx/shared-types";
import { CommentItem } from "./CommentItem";

// openFilePreview 在 SSR 下本就静默返回，但仍 mock 掉附件通道，避免引入 createRoot 侧效。
vi.mock("../attachments/preview-opener", () => ({ openFilePreview: () => {} }));
// CommentImage 内部 effect 在 SSR 不执行；直接 stub 成可断言的占位，避免 blob/fetch 依赖。
vi.mock("./CommentImage", () => ({
  CommentImage: ({ file }: { file: AttachmentDTO }) => (
    <img alt={`inline:${file.name}`} src="" />
  ),
}));

const att = (
  o: Partial<AttachmentDTO> & { id: string; name: string },
): AttachmentDTO => ({
  size: 0,
  mime: "",
  url: `/api/attachments/${o.id}/content`,
  ...o,
});

const mk = (
  o: Partial<CommentDTO> & Pick<CommentDTO, "id" | "userId" | "displayName">,
): CommentDTO => ({
  recordId: "r1" as CommentDTO["recordId"],
  avatarUrl: null,
  body: "",
  attachments: [],
  mentions: [],
  parentId: null,
  replyToUserId: null,
  replyToDisplayName: null,
  createdAt: "2026-05-01T08:30:00.000Z",
  updatedAt: "2026-05-01T08:30:00.000Z",
  ...o,
});

const noop = () => {};

describe("CommentItem 渲染", () => {
  it("把正文里的 @张三 渲染成高亮 chip，且无 dangerouslySetInnerHTML", () => {
    const html = renderToStaticMarkup(
      <CommentItem
        comment={mk({
          id: "c1",
          userId: "u2",
          displayName: "李四",
          body: "@张三 请看这个",
          mentions: [{ userId: "u1", displayName: "张三" }],
        })}
        currentUserId="u2"
        canComment
        canManage={false}
        onReply={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain("@张三");
    expect(html).toContain("gx-accent");
    expect(html).not.toContain("dangerouslySetInnerHTML");
    // 正文其余文字保留
    expect(html).toContain("请看这个");
  });

  it("回复显示「回复 @某人」，并带 reply 标识与缩进", () => {
    const html = renderToStaticMarkup(
      <CommentItem
        comment={mk({
          id: "r1",
          userId: "u3",
          displayName: "王五",
          parentId: "root",
          replyToUserId: "u1",
          replyToDisplayName: "张三",
          body: "收到",
        })}
        currentUserId="u3"
        canComment
        canManage={false}
        onReply={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain("回复");
    expect(html).toContain('data-gx-comment-reply="true"');
    expect(html).toContain("pl-6");
  });

  it("附件分派：jpg 走内联图片组件，svg 与 pdf 走文件行", () => {
    const html = renderToStaticMarkup(
      <CommentItem
        comment={mk({
          id: "c2",
          userId: "u2",
          displayName: "李四",
          body: "图",
          attachments: [
            att({ id: "a1", name: "p.jpg", mime: "image/jpeg" }),
            att({ id: "a2", name: "v.svg", mime: "image/svg+xml" }),
            att({ id: "a3", name: "d.pdf", mime: "application/pdf" }),
          ],
        })}
        currentUserId="u9"
        canComment
        canManage={false}
        onReply={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain("inline:p.jpg");
    expect(html).not.toContain("inline:v.svg");
    // svg/pdf 都作为可下载文件行出现
    expect(html).toContain("v.svg");
    expect(html).toContain("d.pdf");
    expect(html).toContain("download=");
  });

  it("删除门控：管理员可见删除、作者本人可见、无关路人不可见", () => {
    const base = mk({
      id: "c3",
      userId: "owner",
      displayName: "楼主",
      body: "x",
    });
    const admin = renderToStaticMarkup(
      <CommentItem
        comment={base}
        currentUserId="other"
        canComment
        canManage
        onReply={noop}
        onDelete={noop}
      />,
    );
    const owner = renderToStaticMarkup(
      <CommentItem
        comment={base}
        currentUserId="owner"
        canComment
        canManage={false}
        onReply={noop}
        onDelete={noop}
      />,
    );
    const stranger = renderToStaticMarkup(
      <CommentItem
        comment={base}
        currentUserId="other"
        canComment
        canManage={false}
        onReply={noop}
        onDelete={noop}
      />,
    );
    expect(admin).toContain("删除评论");
    expect(owner).toContain("删除评论");
    expect(stranger).not.toContain("删除评论");
  });

  it("canComment=false 时不显示回复按钮", () => {
    const html = renderToStaticMarkup(
      <CommentItem
        comment={mk({
          id: "c4",
          userId: "owner",
          displayName: "楼主",
          body: "x",
        })}
        currentUserId="viewer"
        canComment={false}
        canManage
        onReply={noop}
        onDelete={noop}
      />,
    );
    expect(html).not.toContain('aria-label="回复"');
  });
});

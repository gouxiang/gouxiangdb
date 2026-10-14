// apps/web/src/features/comments/CommentComposer.test.tsx
// 输入器渲染回归（node：react-dom/server）。交互裁决（@ 选择/payload/门控）已在 logic.test.ts 覆盖，
// 这里锁结构与源码护栏：无评论权限不渲染、空内容禁发、回复态目标条、附件/拖拽提示、无 emoji/危险 HTML。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RosterMember } from "../contacts/member-roster";
import { CommentComposer } from "./CommentComposer";

// 切断 XHR/鉴权与 api/client 重链：发送/上传在 SSR 不会被触发。
vi.mock("../attachments/api", () => ({ uploadAttachmentFile: vi.fn() }));

const members: RosterMember[] = [
  { id: "u1", displayName: "张三", email: "zhangsan@x.com", avatarUrl: null },
];
const noop = () => {};

const render = (props: Partial<Parameters<typeof CommentComposer>[0]> = {}) =>
  renderToStaticMarkup(
    <CommentComposer
      baseId="b1"
      tableId="t1"
      recordId="r1"
      canComment
      members={members}
      replyTarget={null}
      onCancelReply={noop}
      onSubmit={noop}
      {...props}
    />,
  );

describe("CommentComposer 渲染与门控", () => {
  it("无评论权限直接不渲染", () => {
    expect(render({ canComment: false })).toBe("");
  });

  it("初始空内容：发表按钮 disabled（空内容禁发）", () => {
    const html = render();
    expect(html).toContain("发表");
    const btn = /<button[^>]*>\s*发表\s*<\/button>/.exec(html);
    expect(btn).toBeTruthy();
    expect(btn![0]).toContain("disabled");
  });

  it("回复态显示「回复 @某人」目标条与取消回复入口，按钮文案为回复", () => {
    const html = render({
      replyTarget: { rootId: "root1", userId: "u1", displayName: "张三" },
    });
    expect(html).toContain("回复 @张三");
    expect(html).toContain("取消回复");
    expect(html).toContain(">回复<");
  });

  it("占位提示包含 @ 成员 / 拖入或粘贴图片 / Enter 发送", () => {
    const html = render();
    expect(html).toContain("@ 可提及成员");
    expect(html).toContain("拖入/粘贴图片");
    expect(html).toContain("Enter 发送");
  });

  it("隐藏的文件选择 input 存在且 multiple", () => {
    const html = render();
    expect(html).toContain('type="file"');
    expect(html).toContain("multiple");
  });

  it("上传中（外部 submitting）按钮处于 loading/禁用", () => {
    const html = render({ submitting: true });
    expect(html).toContain('aria-busy="true"');
  });
});

// 源码护栏：交互细节无法用 SSR 事件模拟，改为直接锁定源文件不回退到危险实现。
describe("CommentComposer 源码护栏", () => {
  const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
  const src = readFileSync(here("./CommentComposer.tsx"), "utf8");
  const hookSrc = readFileSync(here("./useCommentAttachments.ts"), "utf8");
  it("不用 dangerouslySetInnerHTML", () => {
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
  it("粘贴图片走 collectPastedImages、拖放走 collectFiles", () => {
    expect(src).toContain("collectPastedImages");
    expect(src).toContain("collectFiles(");
  });
  it("上传走统一 XHR 通道并带 purpose comment（不裸 fetch）", () => {
    expect(hookSrc).toContain("uploadAttachmentFile");
    expect(hookSrc).toContain('purpose: "comment"');
    expect(hookSrc).not.toMatch(/fetch\s*\(/);
  });
  it("发送载荷由 buildCommentPayload 构造，回复带 parentId/replyToUserId", () => {
    expect(src).toContain("buildCommentPayload");
    expect(src).toContain("replyToUserId");
  });
  it("@ 浮层支持上下键/回车/Tab/Esc 全键盘交互", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"])
      expect(src).toContain(k);
  });
  it("空内容禁发门控来自 canSubmit，发送中禁用", () => {
    expect(src).toContain("canSubmit");
  });
});

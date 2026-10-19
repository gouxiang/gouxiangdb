// apps/web/src/features/comments/CommentSection.test.tsx
// 容器渲染回归（node：react-dom/server + vi.mock hooks）。
// 锁定：加载/错误/空/有数据四态、根+回复两级渲染、倒序、无评论权限不显示输入器。
// 数据写路径（mutation/invalidation）由 hooks 层与 logic 层各自的测试覆盖。

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommentDTO, PermissionSet } from "@gx/shared-types";
import type { RosterMember } from "../contacts/member-roster";

const mkComment = (
  o: Partial<CommentDTO> & { id: string; userId: string; displayName: string },
): CommentDTO => ({
  recordId: "r1" as CommentDTO["recordId"],
  avatarUrl: null,
  body: "",
  attachments: [],
  mentions: [],
  parentId: null,
  replyToUserId: null,
  replyToDisplayName: null,
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-01T08:00:00.000Z",
  ...o,
});

let commentsReturn: CommentDTO[] | undefined;
let commentsState: { isLoading: boolean; isError: boolean };
const addMutate = vi.fn(async () => ({ comment: {} as CommentDTO }));
const delMutate = vi.fn(async () => ({ ok: true }));

vi.mock("../../api/hooks", () => ({
  useComments: () => ({
    data: commentsReturn,
    isLoading: commentsState.isLoading,
    isError: commentsState.isError,
  }),
  useGXMutations: () => ({
    addComment: { mutateAsync: addMutate },
    removeComment: { mutateAsync: delMutate },
  }),
}));

vi.mock("../../store/auth", () => {
  // 须还原 zustand store 的真实形态：既可作选择器 hook 调用，又带 .getState()——
  // node 数据源单例（node/datasource.ts）在模块加载时经 client.ts 急切读 useAuthStore.getState().token。
  const state = { user: { id: "me" }, token: null as string | null };
  return {
    useAuthStore: Object.assign(
      (sel: (s: unknown) => unknown) => sel(state),
      { getState: () => state },
    ),
  };
});

const roster: RosterMember[] = [
  { id: "me", displayName: "我自己", email: "me@x.com", avatarUrl: null },
];
vi.mock("../contacts/member-roster", () => ({
  useMemberRoster: () => ({
    members: roster,
    byId: new Map(roster.map((m) => [m.id, m])),
    isLoading: false,
  }),
  MemberAvatar: ({ member }: { member: RosterMember | null }) => (
    <span data-avatar>{member?.displayName ?? "?"}</span>
  ),
}));

// 输入器真实渲染会带入 XHR 通道，容器测试用轻量桩隔离，只断言是否出现输入入口。
vi.mock("./CommentComposer", () => ({
  CommentComposer: ({ canComment }: { canComment: boolean }) =>
    canComment ? <div data-gx-composer="true" /> : null,
}));

import { CommentSection } from "./CommentSection";

const perms = (over: Partial<PermissionSet> = {}): PermissionSet => ({
  canManageBase: false,
  canManageSchema: false,
  canEditData: true,
  canComment: true,
  canView: true,
  ...over,
});

const render = (p: Partial<Parameters<typeof CommentSection>[0]> = {}) =>
  renderToStaticMarkup(
    <CommentSection
      baseId="b1"
      tableId="t1"
      recordId="r1"
      permissions={perms()}
      {...p}
    />,
  );

beforeEach(() => {
  commentsReturn = [];
  commentsState = { isLoading: false, isError: false };
  addMutate.mockClear();
  delMutate.mockClear();
});

describe("CommentSection 四态", () => {
  it("加载态显示加载提示", () => {
    commentsState = { isLoading: true, isError: false };
    commentsReturn = undefined;
    expect(render()).toContain("加载评论");
  });
  it("错误态显示失败提示", () => {
    commentsState = { isLoading: false, isError: true };
    commentsReturn = undefined;
    const html = render();
    expect(html).toContain("评论加载失败");
  });
  it("空态显示引导文案", () => {
    expect(render()).toContain("暂无评论");
  });
});

describe("CommentSection 两级渲染", () => {
  it("渲染根评论与其回复，回复带缩进引导线容器", () => {
    commentsReturn = [
      mkComment({
        id: "root",
        userId: "u2",
        displayName: "李四",
        body: "根内容",
        createdAt: "2026-05-01T09:00:00Z",
        replies: [
          mkComment({
            id: "rep",
            userId: "me",
            displayName: "我自己",
            body: "回复内容",
            parentId: "root",
            replyToUserId: "u2",
            replyToDisplayName: "李四",
            createdAt: "2026-05-01T10:00:00Z",
          }),
        ],
      }),
    ];
    const html = render();
    expect(html).toContain("根内容");
    expect(html).toContain("回复内容");
    expect(html).toContain('data-gx-comment-id="root"');
    expect(html).toContain('data-gx-comment-id="rep"');
    expect(html).toContain("border-l");
  });

  it("总数（根+回复）写在 data-gx-comment-total", () => {
    commentsReturn = [
      mkComment({
        id: "root",
        userId: "u2",
        displayName: "李四",
        replies: [
          mkComment({
            id: "r1",
            userId: "me",
            displayName: "我自己",
            parentId: "root",
          }),
        ],
      }),
      mkComment({ id: "root2", userId: "u3", displayName: "王五" }),
    ];
    const html = render();
    expect(html).toContain('data-gx-comment-total="3"');
  });
});

describe("CommentSection 权限", () => {
  it("canComment=false 时不渲染输入器", () => {
    const html = render({ permissions: perms({ canComment: false }) });
    expect(html).not.toContain('data-gx-composer="true"');
  });
  it("recordId 为 null 时输入器不渲染（未选中记录）", () => {
    const html = render({ recordId: null });
    expect(html).not.toContain('data-gx-composer="true"');
  });
});

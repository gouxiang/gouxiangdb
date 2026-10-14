// apps/web/src/features/comments/CommentSection.tsx
// 记录详情评论区容器：拉取/发送/删除评论 + 两级渲染（根倒序、回复升序缩进带引导线）。
//
// 数据：useComments（后端已按根倒序返回；这里再经 organizeComments 归一，兼容扁平/嵌套两形态）。
// 权限：canComment 控制输入与回复；删除门控 = canManageSchema || canManageBase || 本人。
// 当前用户从 useAuthStore 取（与 RecordDrawer 同源），头像经成员名册解析。

import { useMemo, useState } from "react";
import type { CreateCommentRequest, PermissionSet } from "@gx/shared-types";
import { useComments, useGXMutations } from "../../api/hooks";
import { useAuthStore } from "../../store/auth";
import { toast, Spinner } from "../../components/ui";
import { useWriteGuard } from "../../components/interaction";
import { useMemberRoster } from "../contacts/member-roster";
import { organizeComments, totalComments, type ReplyTarget } from "./logic";
import { CommentItem } from "./CommentItem";
import { CommentComposer } from "./CommentComposer";

export interface CommentSectionProps {
  baseId: string;
  tableId: string;
  recordId: string | null;
  permissions: PermissionSet;
  /** 可选：外部直接给定当前用户 id；缺省从 auth store 取。 */
  currentUserId?: string | null;
}

export function CommentSection({
  baseId,
  tableId,
  recordId,
  permissions,
  currentUserId,
}: CommentSectionProps) {
  const { data, isLoading, isError } = useComments(recordId);
  const m = useGXMutations();
  const guard = useWriteGuard();
  const { members, byId, isLoading: rosterLoading } = useMemberRoster();
  const storeUser = useAuthStore((s) => s.user);
  const meId = currentUserId ?? storeUser?.id ?? null;

  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);

  const roots = useMemo(() => organizeComments(data), [data]);
  const total = useMemo(() => totalComments(data), [data]);
  const canManage = permissions.canManageSchema || permissions.canManageBase;
  const canComment = !!permissions.canComment && !!recordId;

  // 返回 true 才清空 composer；失败 toast 并保留草稿/已传附件，允许重试。
  const handleSubmit = async (
    payload: CreateCommentRequest,
  ): Promise<boolean> => {
    if (!recordId) {
      toast("请先选择一条记录后再发表评论", "error");
      return false;
    }
    const ran = await guard.run("comment:add", async () => {
      try {
        await m.addComment.mutateAsync({ recordId, data: payload });
        setReplyTarget(null);
        return true;
      } catch (err) {
        toast((err as Error).message || "评论失败", "error");
        return false;
      }
    });
    return ran === true;
  };

  const handleDelete = async (commentId: string) => {
    if (!recordId) return;
    await guard.run(`comment:del:${commentId}`, async () => {
      try {
        await m.removeComment.mutateAsync({ commentId, recordId });
      } catch (err) {
        toast((err as Error).message || "删除失败", "error");
      }
    });
  };

  return (
    <div className="px-4 pb-4" data-gx-comment-total={total}>
      <CommentComposer
        baseId={baseId}
        tableId={tableId}
        recordId={recordId ?? ""}
        canComment={canComment}
        members={members}
        rosterLoading={rosterLoading}
        replyTarget={replyTarget}
        onCancelReply={() => setReplyTarget(null)}
        submitting={guard.isBusy("comment:add")}
        onSubmit={handleSubmit}
      />

      <div className="mt-3">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-gx-12 text-gx-text-hint">
            <Spinner size={14} />
            <span>加载评论…</span>
          </div>
        ) : isError ? (
          <div className="py-2 text-gx-12 text-gx-danger">
            评论加载失败，请稍后重试
          </div>
        ) : roots.length === 0 ? (
          <div className="py-2 text-gx-12 text-gx-text-hint">
            暂无评论，留下第一条吧
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {roots.map((c) => (
              <div key={c.id} className="flex flex-col gap-2">
                <CommentItem
                  comment={c}
                  currentUserId={meId}
                  canComment={canComment}
                  canManage={canManage}
                  member={byId.get(c.userId) ?? null}
                  busy={guard.isBusy(`comment:del:${c.id}`)}
                  onReply={(t) => setReplyTarget(t)}
                  onDelete={handleDelete}
                />
                {c.replies && c.replies.length > 0 && (
                  <div className="ml-3 flex flex-col gap-2 border-l border-gx-hairline pl-3">
                    {c.replies.map((r) => (
                      <CommentItem
                        key={r.id}
                        comment={r}
                        currentUserId={meId}
                        canComment={canComment}
                        canManage={canManage}
                        member={byId.get(r.userId) ?? null}
                        busy={guard.isBusy(`comment:del:${r.id}`)}
                        onReply={(t) => setReplyTarget(t)}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

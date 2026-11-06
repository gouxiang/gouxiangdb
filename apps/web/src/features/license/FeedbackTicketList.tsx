// 官方反馈工单列表：60s 轮询 /feedback/poll，可展开查看消息与官方回复、追加回复（可带附件）。
// 附件走本仓同源代理 GET /api/license/feedback/attachment?path=，因鉴权用 X-GX-Token 头
// （顶层导航/img 无法带自定义头），统一 fetch 字节 → blob URL 预览/下载，用完 revoke。
import { useEffect, useMemo, useState } from "react";
import { Button, IconButton, Spinner, Textarea, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  fetchLicenseAttachment,
  type FeedbackAttachmentView,
  type FeedbackTicketView,
} from "../../api/license";
import { toBlobUrl } from "../attachments/api";
import { usePollFeedback, useReplyFeedback } from "./license-hooks";
import { categoryLabel, formatBytes, ticketStatusLabel } from "./feedback-policy";

function FeedbackAttachment({ att }: { att: FeedbackAttachmentView }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    if (!att.path) return;
    setLoading(true);
    fetchLicenseAttachment(att.path)
      .then(({ bytes, contentType }) => {
        if (revoked) return;
        created = toBlobUrl(bytes, contentType);
        setUrl(created);
        setFailed(false);
      })
      .catch(() => {
        if (!revoked) setFailed(true);
      })
      .finally(() => {
        if (!revoked) setLoading(false);
      });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [att.path]);

  const open = () => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <button
      type="button"
      onClick={open}
      disabled={!url || loading || failed}
      title={failed ? "附件暂时不可用" : att.name}
      className="inline-flex max-w-full items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-2 py-1 text-gx-12 text-gx-text-secondary transition-colors hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? (
        <Spinner size={12} />
      ) : (
        <Icon name={failed ? "alertCircle" : "paperclip"} size={12} className="shrink-0 text-gx-text-tertiary" />
      )}
      <span className="truncate">{failed ? "附件不可用" : att.name}</span>
      {att.size !== null && <span className="shrink-0 tabular-nums text-gx-text-hint">{formatBytes(att.size)}</span>}
    </button>
  );
}

function TicketItem({ ticket }: { ticket: FeedbackTicketView }) {
  const [open, setOpen] = useState(false);
  const reply = useReplyFeedback();
  const [text, setText] = useState("");

  const send = () => {
    const content = text.trim();
    if (!content) {
      toast("请先填写回复内容", "info");
      return;
    }
    reply.mutate(
      { ticketId: ticket.id, content },
      {
        onSuccess: () => {
          toast("回复已发送", "success");
          setText("");
        },
        onError: () => toast("回复失败，请稍后重试", "error"),
      },
    );
  };

  const time = ticket.updatedAtMs ?? ticket.createdAtMs;

  return (
    <li className="rounded-gx-lg border border-gx-border bg-gx-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-gx-row-hover"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="shrink-0 text-gx-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary">{ticket.subject}</span>
        {ticket.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gx-danger" aria-label="有未读更新" />}
        <span className="shrink-0 rounded-full bg-gx-control px-2 py-0.5 text-gx-11 text-gx-text-tertiary">
          {ticketStatusLabel(ticket.status)}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-gx-hairline px-3 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gx-11 text-gx-text-hint">
            <span>分类：{categoryLabel(ticket.category)}</span>
            {time !== null && <span>{new Date(time).toLocaleString()}</span>}
          </div>
          <ul className="flex flex-col gap-2">
            {ticket.messages.map((m) => (
              <li
                key={m.id}
                className={`rounded-gx-lg px-3 py-2 text-gx-13 leading-6 ${
                  m.staff ? "bg-gx-accent-bg text-gx-text-primary" : "bg-gx-control text-gx-text-secondary"
                }`}
              >
                <div className="mb-0.5 flex items-center gap-1.5 text-gx-11 font-medium text-gx-text-tertiary">
                  <Icon name={m.staff ? "shield" : "user"} size={11} />
                  {m.staff ? "官方回复" : "我"}
                  {m.createdAtMs !== null && <span>{new Date(m.createdAtMs).toLocaleString()}</span>}
                </div>
                <p className="whitespace-pre-line break-words">{m.content}</p>
                {m.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.attachments.filter((a) => a.path).map((a, i) => (
                      <FeedbackAttachment key={`${a.path}-${i}`} att={a} />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2">
            <Textarea
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="补充说明或回复官方…"
            />
            <div>
              <Button variant="secondary" size="sm" icon="reply" loading={reply.isPending} onClick={send}>
                发送回复
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export function FeedbackTicketList({ enabled }: { enabled: boolean }) {
  // 首次全量；之后由 60s refetchInterval 重新拉全量（后台按指纹返回全部工单，数量级很小）。
  const { data, isLoading, isError, refetch, isFetching } = usePollFeedback(enabled, null);
  const tickets = useMemo(() => data?.tickets ?? [], [data]);

  if (!enabled) return null;
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-4 text-gx-12 text-gx-text-tertiary">
        <Spinner size={14} /> 正在加载工单…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-gx-lg border border-gx-border bg-gx-control px-3 py-3">
        <Icon name="alertCircle" size={14} className="shrink-0 text-gx-warning" />
        <span className="flex-1 text-gx-12 text-gx-text-secondary">工单暂时加载失败，不影响提交反馈。</span>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          重试
        </Button>
      </div>
    );
  }
  if (tickets.length === 0) {
    return <p className="px-1 py-2 text-gx-12 text-gx-text-hint">还没有反馈工单，提交后官方回复会显示在这里。</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-gx-14 font-semibold text-gx-text-primary">我的工单</h3>
        <IconButton icon="refresh" label="刷新工单" size={14} onClick={() => void refetch()} />
      </div>
      {isFetching && <span className="sr-only">刷新中</span>}
      <ul className="flex flex-col gap-2">
        {tickets.map((t) => (
          <TicketItem key={t.id} ticket={t} />
        ))}
      </ul>
    </div>
  );
}

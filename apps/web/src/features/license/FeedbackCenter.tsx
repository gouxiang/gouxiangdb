// 全员反馈中心：提交反馈 + 工单列表。授权服务 off（available=false）时提示不可用、
// 不渲染表单（写端点此时 404 LICENSE_DISABLED）；on 时任何登录成员可用（不限管理员）。
// status.feedback.unread 角标随 /status 30s 轮询刷新；打开工单列表后由 poll 清后台角标。
import { Icon } from "../../components/icons";
import { useLicenseStatus } from "./license-hooks";
import { FeedbackComposer } from "./FeedbackComposer";
import { FeedbackTicketList } from "./FeedbackTicketList";

export function FeedbackCenter() {
  const { data: status } = useLicenseStatus();
  const available = status.available;
  const unread = status.feedback?.unread ?? 0;
  const openCount = status.feedback?.open ?? 0;

  if (!available) {
    return (
      <section className="flex items-start gap-2 rounded-gx-lg border border-gx-border bg-gx-control px-4 py-4">
        <Icon name="comment" size={16} className="mt-0.5 shrink-0 text-gx-text-tertiary" />
        <div>
          <h3 className="text-gx-14 font-semibold text-gx-text-primary">官方反馈</h3>
          <p className="mt-1 text-gx-12 leading-5 text-gx-text-tertiary">
            当前部署未启用授权服务，官方反馈通道暂不可用。如有授权或账单问题，请直接联系部署管理员。
          </p>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-gx-18 font-semibold text-gx-text-primary">官方反馈</h2>
          <p className="mt-1 text-gx-13 text-gx-text-tertiary">
            向官方提交账单、授权与技术问题，并在这里查看回复。
          </p>
        </div>
        {(unread > 0 || openCount > 0) && (
          <div className="flex items-center gap-2 text-gx-12 text-gx-text-tertiary">
            {unread > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-gx-danger-bg px-2 py-0.5 text-gx-danger">
                <span className="h-1.5 w-1.5 rounded-full bg-gx-danger" />
                {unread} 条未读更新
              </span>
            )}
            {openCount > 0 && <span>{openCount} 个处理中工单</span>}
          </div>
        )}
      </div>
      <FeedbackComposer />
      <FeedbackTicketList enabled={available} />
    </div>
  );
}

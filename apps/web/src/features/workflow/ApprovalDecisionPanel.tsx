// 单张 pending 审批单的裁决面板（#1321 刀 C3-b2）：通过/驳回 + 可选审批意见。
//
// 数据只走 useDecideApproval（禁裸 fetch；mutation 成功后 invalidate 整个 ["workflow","runs"] 域，
// 缓存自动刷新、面板随审批单状态翻转自行消失，故这里不手写 refetch）。两个按钮共用 isPending，天然防重复
// 提交；裁决错误统一 workflowErrorText(normalizeWorkflowError) 收口（403 非审批人/409 已裁决文案已内置）。
import { useState } from "react";
import { Button, FieldRow, Textarea, toast } from "../../components/ui";
import type { WorkflowApprovalDTO } from "@gx/shared-types";
import { useDecideApproval } from "./workflow-hooks";
import { normalizeWorkflowError, workflowErrorText } from "./lib/workflow-error";

export function ApprovalDecisionPanel({ approval }: { approval: WorkflowApprovalDTO }) {
  const decide = useDecideApproval();
  const [comment, setComment] = useState("");

  function submit(decision: "approved" | "rejected") {
    const trimmed = comment.trim();
    decide.mutate(
      {
        approvalId: approval.id,
        input: trimmed ? { decision, comment: trimmed } : { decision },
      },
      {
        onSuccess: () =>
          toast(decision === "approved" ? "已提交通过裁决" : "已提交驳回裁决", "success"),
        onError: (e) => toast(workflowErrorText(normalizeWorkflowError(e)), "error"),
      },
    );
  }

  return (
    <div
      className="flex flex-col gap-2 border-t border-gx-separator pt-2"
      data-gx-approval-decision={approval.id}
    >
      <FieldRow label="审批意见" hint="可选；通过或驳回都可附言">
        <Textarea
          rows={3}
          value={comment}
          maxLength={500}
          placeholder="填写审批意见（可选）"
          onChange={(e) => setComment(e.target.value)}
        />
      </FieldRow>
      <div className="flex gap-2">
        <Button
          variant="primary"
          icon="check"
          loading={decide.isPending}
          onClick={() => submit("approved")}
        >
          通过
        </Button>
        <Button
          variant="danger"
          icon="close"
          loading={decide.isPending}
          onClick={() => submit("rejected")}
        >
          驳回
        </Button>
      </div>
    </div>
  );
}

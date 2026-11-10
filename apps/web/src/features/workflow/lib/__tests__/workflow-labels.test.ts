// 工作流状态/类型中文标签纯函数单测（#1309 刀 C1，纯 node，零 IO/React）。
//
// 锁三件事：
//   ① 五组 Record<冻结联合,string> 对枚举每个成员都有非空中文标签（漏改在编译期已被 Record 穷举拦住，
//      这里再用冻结数组运行期逐一兜底，防止有人把类型放宽成 Partial 后静默出空白）；
//   ② 关键文案锁定：canceled 单 l →「已取消」，拼写与文案双重冻结；
//   ③ labelOr 前向兼容：未知字符串（旧前端遇后端新枚举）回落原文，绝不渲染空白。
import { describe, it, expect } from "vitest";
import {
  WORKFLOW_NODE_TYPES,
  WORKFLOW_DEF_STATUSES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_APPROVAL_STATUSES,
  WORKFLOW_TRIGGER_TYPES,
} from "@gx/shared-types";
import {
  WORKFLOW_DEF_STATUS_LABEL,
  WORKFLOW_RUN_STATUS_LABEL,
  WORKFLOW_APPROVAL_STATUS_LABEL,
  WORKFLOW_TRIGGER_TYPE_LABEL,
  WORKFLOW_NODE_TYPE_LABEL,
  workflowDefStatusLabel,
  workflowRunStatusLabel,
  workflowApprovalStatusLabel,
  workflowTriggerTypeLabel,
  workflowNodeTypeLabel,
} from "../workflow-labels";

describe("五组标签对冻结枚举穷举且均为非空中文", () => {
  it("定义状态：draft/published/disabled 全覆盖", () => {
    for (const s of WORKFLOW_DEF_STATUSES) {
      const label = WORKFLOW_DEF_STATUS_LABEL[s];
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
    expect(WORKFLOW_DEF_STATUS_LABEL).toEqual({
      draft: "草稿",
      published: "已发布",
      disabled: "已停用",
    });
  });

  it("运行状态：六成员全覆盖，canceled（单 l）→ 已取消", () => {
    for (const s of WORKFLOW_RUN_STATUSES) {
      expect(WORKFLOW_RUN_STATUS_LABEL[s].length).toBeGreaterThan(0);
    }
    expect(WORKFLOW_RUN_STATUS_LABEL).toEqual({
      pending: "等待执行",
      running: "执行中",
      waiting_approval: "等待审批",
      succeeded: "执行成功",
      failed: "执行失败",
      canceled: "已取消", // 单 l 冻结；双 l cancelled 不是合法键
    });
  });

  it("审批单状态：pending/approved/rejected 全覆盖", () => {
    for (const s of WORKFLOW_APPROVAL_STATUSES) {
      expect(WORKFLOW_APPROVAL_STATUS_LABEL[s].length).toBeGreaterThan(0);
    }
    expect(WORKFLOW_APPROVAL_STATUS_LABEL).toEqual({
      pending: "待审批",
      approved: "已通过",
      rejected: "已驳回",
    });
  });

  it("触发器类型：四成员全覆盖", () => {
    for (const t of WORKFLOW_TRIGGER_TYPES) {
      expect(WORKFLOW_TRIGGER_TYPE_LABEL[t].length).toBeGreaterThan(0);
    }
    expect(WORKFLOW_TRIGGER_TYPE_LABEL.manual).toBe("手动触发");
    expect(WORKFLOW_TRIGGER_TYPE_LABEL.record_created).toBe("记录创建时");
    expect(WORKFLOW_TRIGGER_TYPE_LABEL.record_updated).toBe("记录更新时");
    expect(WORKFLOW_TRIGGER_TYPE_LABEL.scheduled).toBe("定时触发");
  });

  it("DAG 节点类型：trigger/action/approval 全覆盖", () => {
    for (const t of WORKFLOW_NODE_TYPES) {
      expect(WORKFLOW_NODE_TYPE_LABEL[t].length).toBeGreaterThan(0);
    }
    expect(WORKFLOW_NODE_TYPE_LABEL).toEqual({
      trigger: "触发器",
      action: "动作",
      approval: "审批",
    });
  });
});

describe("标签函数（含 labelOr 前向兼容回落）", () => {
  it("已知枚举返回对应中文", () => {
    expect(workflowDefStatusLabel("published")).toBe("已发布");
    expect(workflowRunStatusLabel("waiting_approval")).toBe("等待审批");
    expect(workflowApprovalStatusLabel("rejected")).toBe("已驳回");
    expect(workflowTriggerTypeLabel("scheduled")).toBe("定时触发");
    expect(workflowNodeTypeLabel("approval")).toBe("审批");
  });

  it("未知字符串回落原文（不渲染空白、不抛错）", () => {
    expect(workflowRunStatusLabel("paused")).toBe("paused");
    expect(workflowDefStatusLabel("archived")).toBe("archived");
    expect(workflowApprovalStatusLabel("delegated")).toBe("delegated");
    expect(workflowTriggerTypeLabel("webhook")).toBe("webhook");
    expect(workflowNodeTypeLabel("condition")).toBe("condition");
  });

  it("双 l 误拼 cancelled 不是已知运行态：回落原文而非命中「已取消」", () => {
    // 反向证明 canceled 单 l 才是词典键，防止有人顺手改成双 l。
    expect(workflowRunStatusLabel("cancelled")).toBe("cancelled");
    expect(workflowRunStatusLabel("canceled")).toBe("已取消");
  });
});

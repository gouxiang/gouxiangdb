// 工作流错误归一 + 机器码人话纯函数（#1317 刀 C3-a1）：零 IO、零 React，可表驱动单测。
//
// 仿 features/settings/pat-hooks.ts:75 normalizePatError + pat-labels.ts:163 patErrorText 的两段式：
//   ① normalizeWorkflowError 把任意 catch 到的 unknown 归一为结构化 WorkflowErrorInfo；
//   ② workflowErrorText 只按【机器码 / HTTP status】分支翻中文，绝不匹配后端中文 message 文案
//      （文案会变，code 不会）。message 仅作为 400/未知错误的兜底透传，不参与条件判断。
//
// 路径深度：本文件在 features/workflow/lib/（lib→workflow→features→src 三层），
//   故 ApiError 相对路径是 ../../../api/client（比 features/settings 深一层，勿照抄 ../../）。
//   ApiError 是 class（instanceof + 测试里 new），必须值导入，不能 import type。
import { ApiError } from "../../../api/client";
import { WORKFLOW_ERROR_CODES } from "@gx/shared-types";
import type { WorkflowErrorCode } from "@gx/shared-types";

/** 归一后的错误结构：非 ApiError（网络异常/未知 throw）统一 status=0、各字段 null。 */
export interface WorkflowErrorInfo {
  status: number;
  /** 仅当 body.code 是 shared-types 12 个工作流机器码之一才收窄，否则 null。 */
  code: WorkflowErrorCode | null;
  /** 后端中文 message（优先 body.error，回落 body.message）；仅供兜底展示，不用于分支。 */
  message: string | null;
  /** 429 Retry-After 秒数（ApiError.retryAfter），缺省 null。 */
  retryAfterSec: number | null;
}

/** 判断字符串是否落在 12 个工作流机器码白名单内（收窄成 WorkflowErrorCode）。 */
function isWorkflowErrorCode(code: string): code is WorkflowErrorCode {
  return (WORKFLOW_ERROR_CODES as readonly string[]).includes(code);
}

/** 把任意错误归一为 {@link WorkflowErrorInfo}；非 ApiError 视为网络/未知错误，不抛错。 */
export function normalizeWorkflowError(e: unknown): WorkflowErrorInfo {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown; message?: unknown; code?: unknown };
    const rawCode = typeof body?.code === "string" ? body.code : null;
    const code = rawCode !== null && isWorkflowErrorCode(rawCode) ? rawCode : null;
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : null;
    return { status: e.status, code, message, retryAfterSec: e.retryAfter ?? null };
  }
  return { status: 0, code: null, message: null, retryAfterSec: null };
}

/** 12 个工作流机器码 → 中性中文（Record 穷举：后端新增码而这里漏改，tsc 立即红）。 */
export const WORKFLOW_ERROR_TEXT: Record<WorkflowErrorCode, string> = {
  WORKFLOW_DISABLED: "工作流功能未启用",
  WORKFLOW_NAME_EMPTY: "名称不能为空",
  WORKFLOW_GRAPH_INVALID: "流程图定义不合法",
  WORKFLOW_TRIGGER_INVALID: "触发器类型不合法",
  WORKFLOW_DEF_NOT_FOUND: "流程定义不存在或已被删除",
  WORKFLOW_DEF_NOT_DRAFT: "仅草稿状态的流程可以发布",
  WORKFLOW_DEF_NOT_PUBLISHED: "仅已发布的流程可以手动触发",
  WORKFLOW_APPROVAL_INVALID: "审批决定无效",
  WORKFLOW_APPROVAL_NOT_FOUND: "审批单不存在",
  WORKFLOW_APPROVAL_DECIDED: "该审批已裁决，不能重复操作",
  WORKFLOW_NOT_APPROVER: "你不在该审批的可审批人范围内",
  WORKFLOW_RUN_NOT_FOUND: "运行记录不存在或已被删除",
};

/**
 * 错误 → 用户可读中文：
 *   - 有合法机器码：直接查 WORKFLOW_ERROR_TEXT（程序判定的唯一权威来源）；
 *   - 无码（code=null）：按 HTTP status 中性兜底；429 尊重 Retry-After 提示退避秒数，绝不自动重试；
 *   - 其余/未知：透传后端 message，再不行用调用方 fallback。
 */
export function workflowErrorText(
  info: WorkflowErrorInfo,
  fallback = "操作失败，请稍后重试",
): string {
  if (info.code !== null) {
    const text = WORKFLOW_ERROR_TEXT[info.code];
    if (text) return text;
  }
  const { status, message, retryAfterSec } = info;
  if (status === 403) return "当前环境未开放此功能";
  if (status === 404) return "资源不存在";
  if (status === 429) {
    return retryAfterSec !== null && retryAfterSec > 0
      ? `操作过于频繁，请 ${retryAfterSec} 秒后重试`
      : "操作过于频繁，请稍后重试";
  }
  if (status === 400) return message ?? "请求有误，请检查填写";
  return message ?? fallback;
}

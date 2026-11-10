// 工作流错误归一 + 机器码人话单测（#1317 刀 C3-a1，纯 node，零 IO/React/依赖）。
//
// 锁四件事：
//   ① normalizeWorkflowError：ApiError 抽 status/code/message/retryAfter，code 仅在 12 码白名单内才收窄；
//   ② 非 ApiError（网络异常/任意 throw）统一 status=0、各字段 null，绝不抛错；
//   ③ WORKFLOW_ERROR_TEXT 对 12 码穷举且非空（Record 编译期兜底，这里运行期再锁）；
//   ④ workflowErrorText 只按 code/status 分支，429 尊重 Retry-After，不匹配中文 message 文案。
//
// 路径深度：本文件在 features/workflow/lib/__tests__/（比源文件多一层 __tests__），
//   到 src/api/client 是【四层】../../../../api/client（同构先例 features/kb/canvas/__tests__）。
import { describe, it, expect } from "vitest";
import { WORKFLOW_ERROR_CODES } from "@gx/shared-types";
import { ApiError } from "../../../../api/client";
import {
  normalizeWorkflowError,
  workflowErrorText,
  WORKFLOW_ERROR_TEXT,
} from "../workflow-error";

describe("normalizeWorkflowError 归一", () => {
  it("ApiError + 已知工作流码：完整收窄 status/code/message", () => {
    const e = new ApiError(409, { code: "WORKFLOW_APPROVAL_DECIDED", error: "已裁决" });
    const info = normalizeWorkflowError(e);
    expect(info).toEqual({
      status: 409,
      code: "WORKFLOW_APPROVAL_DECIDED",
      message: "已裁决",
      retryAfterSec: null,
    });
  });

  it("body 未知 code 不收窄为 null，但保留 status/message", () => {
    const e = new ApiError(400, { code: "SOME_OTHER_CODE", error: "坏请求" });
    const info = normalizeWorkflowError(e);
    expect(info.code).toBeNull();
    expect(info.status).toBe(400);
    expect(info.message).toBe("坏请求");
  });

  it("body.code 非字符串时收窄为 null（typeof 守卫）", () => {
    const body = { code: 123 } as unknown as { code?: string };
    const info = normalizeWorkflowError(new ApiError(400, body));
    expect(info.code).toBeNull();
  });

  it("message 优先取 body.error，缺失时回落 body.message", () => {
    const a = normalizeWorkflowError(new ApiError(400, { error: "错误文案" }));
    const b = normalizeWorkflowError(new ApiError(400, { message: "消息文案" }));
    expect(a.message).toBe("错误文案");
    expect(b.message).toBe("消息文案");
  });

  it("429 带 Retry-After：retryAfterSec 取第三参", () => {
    const info = normalizeWorkflowError(new ApiError(429, { error: "限流" }, 30));
    expect(info.status).toBe(429);
    expect(info.retryAfterSec).toBe(30);
  });

  it("非 ApiError（Error/字符串/null/undefined）统一 status=0 且字段全 null，不抛错", () => {
    const expected = { status: 0, code: null, message: null, retryAfterSec: null };
    for (const e of [new Error("boom"), "raw string", null, undefined, { weird: true }]) {
      expect(normalizeWorkflowError(e)).toEqual(expected);
    }
  });
});

describe("WORKFLOW_ERROR_TEXT 12 码穷举", () => {
  it("冻结数组每个码都有非空中文文案，且键集合与 12 码完全一致", () => {
    for (const code of WORKFLOW_ERROR_CODES) {
      const text = WORKFLOW_ERROR_TEXT[code];
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
    expect(Object.keys(WORKFLOW_ERROR_TEXT).sort()).toEqual([...WORKFLOW_ERROR_CODES].sort());
  });
});

describe("workflowErrorText 文案分支", () => {
  it("有合法机器码：直接返回词典文案（优先于 status 分支）", () => {
    const info = normalizeWorkflowError(
      new ApiError(409, { code: "WORKFLOW_APPROVAL_DECIDED", error: "后端原始文案" }),
    );
    expect(workflowErrorText(info)).toBe("该审批已裁决，不能重复操作");
  });

  it("无码 + 403：环境未开放中性提示", () => {
    expect(workflowErrorText(normalizeWorkflowError(new ApiError(403, { error: "x" })))).toBe(
      "当前环境未开放此功能",
    );
  });

  it("无码 + 404：资源不存在", () => {
    expect(workflowErrorText(normalizeWorkflowError(new ApiError(404, {})))).toBe("资源不存在");
  });

  it("无码 + 400：有 message 透传，无 message 用固定提示", () => {
    const withMsg = normalizeWorkflowError(new ApiError(400, { error: "字段缺失" }));
    const noMsg = normalizeWorkflowError(new ApiError(400, {}));
    expect(workflowErrorText(withMsg)).toBe("字段缺失");
    expect(workflowErrorText(noMsg)).toBe("请求有误，请检查填写");
  });

  it("无码 + 429：有 Retry-After 带秒数，无则通用限流提示", () => {
    const withSec = normalizeWorkflowError(new ApiError(429, {}, 30));
    const noSec = normalizeWorkflowError(new ApiError(429, {}));
    expect(workflowErrorText(withSec)).toBe("操作过于频繁，请 30 秒后重试");
    expect(workflowErrorText(noSec)).toBe("操作过于频繁，请稍后重试");
  });

  it("其余 status：透传 message，再不行回落 fallback（默认/自定义）", () => {
    const withMsg = normalizeWorkflowError(new ApiError(500, { error: "服务开小差" }));
    const noMsg = normalizeWorkflowError(new ApiError(502, {}));
    expect(workflowErrorText(withMsg)).toBe("服务开小差");
    expect(workflowErrorText(noMsg)).toBe("操作失败，请稍后重试");
    expect(workflowErrorText(noMsg, "自定义兜底")).toBe("自定义兜底");
  });

  it("非 ApiError（status=0）无 message 时回落 fallback", () => {
    expect(workflowErrorText(normalizeWorkflowError(new Error("net")))).toBe(
      "操作失败，请稍后重试",
    );
  });
});

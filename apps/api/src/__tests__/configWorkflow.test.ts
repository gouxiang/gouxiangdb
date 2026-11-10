// GX_WORKFLOW_ENGINE 总门解析纯函数测试（无 db/Hono，表驱动）。
// 设计权威：需求 #1296 刀 A 地基——默认 off，只有显式 on/true/1 才开，笔误 fail-closed。

import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowEngineFlag, workflowEngineEnabled } from "../configWorkflow.js";

describe("parseWorkflowEngineFlag", () => {
  it("默认关闭：undefined / 空串 / 纯空白", () => {
    expect(parseWorkflowEngineFlag(undefined)).toBe(false);
    expect(parseWorkflowEngineFlag("")).toBe(false);
    expect(parseWorkflowEngineFlag("   ")).toBe(false);
  });

  it("只有 on/true/1（忽略大小写与首尾空白）才开", () => {
    for (const v of ["on", "ON", " On ", "true", "TRUE", "1", " 1 "]) {
      expect(parseWorkflowEngineFlag(v)).toBe(true);
    }
  });

  it("笔误/其他值一律关闭（fail-closed）", () => {
    for (const v of ["off", "opn", "yes", "enabled", "0", "false", "2", "on/off"]) {
      expect(parseWorkflowEngineFlag(v)).toBe(false);
    }
  });
});

describe("workflowEngineEnabled", () => {
  const prev = process.env.GX_WORKFLOW_ENGINE;
  afterEach(() => {
    if (prev === undefined) delete process.env.GX_WORKFLOW_ENGINE;
    else process.env.GX_WORKFLOW_ENGINE = prev;
  });

  it("未设置 -> false；on -> true；off -> false（运行时读 env，可进程内切换）", () => {
    delete process.env.GX_WORKFLOW_ENGINE;
    expect(workflowEngineEnabled()).toBe(false);
    process.env.GX_WORKFLOW_ENGINE = "on";
    expect(workflowEngineEnabled()).toBe(true);
    process.env.GX_WORKFLOW_ENGINE = "off";
    expect(workflowEngineEnabled()).toBe(false);
  });
});

// 刀C2 工作流门控骨架回归（node 环境，react-dom/server 静态渲染 + 源码断言）。
//
// 无 jsdom / happy-dom / @testing-library / msw，无 vitest-environment docblock：
// 三态门控抽成无 hooks 纯组件 WorkflowGate，故 renderToStaticMarkup 即可在 node 直测。
// 锁的验收点：
//   - off（enabled===false）渲染「如何启用」指引卡（含可复制 env 片段），不转圈、不泄漏 children；
//   - 探活中/未决（isLoading 或 enabled===null）中性 Spinner，不预判 on/off；
//   - on（enabled===true）渲染 children，不白屏、不永久转圈；
//   - Gate / DisabledState 无 React hooks 且 ≤300 行（保持可 SSR 直测）；两个页面壳确实接 useWorkflowFlag；
//   - workflow 图标在 icons.tsx 双注册（联合 + PATHS）；两条路由在 App.tsx 登录态布局内。
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { WorkflowGate } from "../WorkflowGate";
import type { WorkflowFlagState } from "../useWorkflowFlag";

const here = (p: string) => new URL(p, import.meta.url);
const read = (p: string) => readFileSync(here(p), "utf8");
/** 剥离块注释与整行注释后判代码本体（注释里允许讲历史，代码里不许出现被禁符号）。 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/** on 态 children 的专属哨兵：off/loading 态都不应渲染它。 */
function ChildProbe() {
  return <div data-gx-workflow-test-child="true">C3-占位-专属文本</div>;
}

const gateHtml = (flag: WorkflowFlagState) =>
  render(
    <WorkflowGate flag={flag}>
      <ChildProbe />
    </WorkflowGate>,
  );

describe("WorkflowGate 三态门控（SSR 静态渲染）", () => {
  it("off（enabled=false）：渲染启用指引卡（含 env 片段），不转圈、不泄漏 on 态 children", () => {
    const html = gateHtml({ enabled: false, isLoading: false });
    expect(html).toContain('data-gx-workflow-disabled="true"');
    expect(html).toContain("GX_WORKFLOW_ENGINE=on");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("data-gx-workflow-test-child");
    expect(html).not.toContain("C3-占位-专属文本");
  });

  it("探活中/未决两态：只给中性 Spinner，不出现停用指引卡", () => {
    for (const flag of [
      { enabled: null, isLoading: false },
      { enabled: null, isLoading: true },
    ] satisfies WorkflowFlagState[]) {
      const html = gateHtml(flag);
      expect(html).toContain("animate-spin");
      expect(html).not.toContain('data-gx-workflow-disabled="true"');
      expect(html).not.toContain("data-gx-workflow-test-child");
    }
  });

  it("on（enabled=true）：渲染 children，既不停用指引卡也不转圈（不白屏、不永久 spinner）", () => {
    const html = gateHtml({ enabled: true, isLoading: false });
    expect(html).toContain('data-gx-workflow-test-child="true"');
    expect(html).toContain("C3-占位-专属文本");
    expect(html).not.toContain('data-gx-workflow-disabled="true"');
    expect(html).not.toContain("animate-spin");
  });
});

describe("源码护栏：门控/指引无 hooks 且 ≤300 行，页面壳接上探针 hook", () => {
  const noHookFiles = ["../WorkflowGate.tsx", "../WorkflowDisabledState.tsx"];

  for (const f of noHookFiles) {
    it(`${f} 剥注释后不含 useState/useQuery/useEffect，且整文件 ≤300 行`, () => {
      const body = code(f);
      expect(body).not.toContain("useState");
      expect(body).not.toContain("useQuery");
      expect(body).not.toContain("useEffect");
      expect(read(f).split("\n").length).toBeLessThanOrEqual(300);
    });
  }

  for (const f of ["../WorkflowDefsPage.tsx", "../WorkflowRunsPage.tsx", "../WorkflowDefDetailPage.tsx", "../WorkflowComposerPage.tsx", "../WorkflowRunDetailPage.tsx"]) {
    it(`${f} 接 useWorkflowFlag 并默认导出，且整文件 ≤300 行`, () => {
      const body = code(f);
      expect(body).toContain("useWorkflowFlag");
      expect(body).toContain("export default function");
      expect(read(f).split("\n").length).toBeLessThanOrEqual(300);
    });
  }
});

describe("注册与路由接线（源码断言）", () => {
  it("workflow 图标在 icons.tsx 双注册：IconName 联合 + PATHS 表（缺一 Record 穷尽 tsc 必红）", () => {
    const icons = code("../../../components/icons.tsx");
    expect(icons).toContain('"workflow"');
    expect(icons).toContain("workflow:");
  });

  it("App.tsx 含 /workflow、/workflow/new、/workflow/runs 与 /workflow/def/:defId 静态路由，且位于 ShellGate 所在登录态布局之后", () => {
    const app = code("../../../App.tsx");
    expect(app).toContain('path="/workflow"');
    expect(app).toContain('path="/workflow/new"');
    expect(app).toContain('path="/workflow/runs"');
    expect(app).toContain('path="/workflow/def/:defId"');
    // 轻量顺序护栏（不解析 JSX）：壳门 <ShellGate /> 在前，工作流路由在其后同一布局块内，new 紧邻 index、详情在 runs 之后。
    expect(app.indexOf("<ShellGate")).toBeGreaterThan(-1);
    expect(app.indexOf('path="/workflow"')).toBeGreaterThan(app.indexOf("<ShellGate"));
    expect(app.indexOf('path="/workflow/new"')).toBeGreaterThan(app.indexOf('path="/workflow"'));
    expect(app.indexOf('path="/workflow/runs"')).toBeGreaterThan(app.indexOf('path="/workflow"'));
    expect(app.indexOf('path="/workflow/def/:defId"')).toBeGreaterThan(
      app.indexOf('path="/workflow/runs"'),
    );
    // 运行详情动态段紧随 runs 静态段之后（v6 静态段优先，两者不冲突），全静态 import。
    expect(app).toContain('path="/workflow/runs/:runId"');
    expect(app.indexOf('path="/workflow/runs/:runId"')).toBeGreaterThan(
      app.indexOf('path="/workflow/runs"'),
    );
    expect(app).toContain('from "./features/workflow/WorkflowRunDetailPage"');
    // 全静态 import，不引 React.lazy
    expect(app).not.toContain("React.lazy");
    expect(app).toContain('from "./features/workflow/WorkflowDefsPage"');
    expect(app).toContain('from "./features/workflow/WorkflowRunsPage"');
    expect(app).toContain('from "./features/workflow/WorkflowDefDetailPage"');
    expect(app).toContain('from "./features/workflow/WorkflowComposerPage"');
  });
});

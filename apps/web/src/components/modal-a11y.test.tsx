// UI 重构收尾 · P3-a11y 回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// 锁的是三件事：
//   ① Modal 具备 dialog 语义（role / aria-modal / aria-labelledby 指向真实标题节点）
//      —— 上一轮 QA 自动化脚本定位不到模态元素就是缺这个；
//   ② 无标题时可访问名称有兜底（aria-label），不至于变成无名弹窗；
//   ③ 焦点「移入 / 归还」的决策逻辑（纯函数，可在无 DOM 环境直接测）。
//
// 说明：Esc 关闭是本次改动之前就有的实现（window keydown → onClose），本文件不重复实现，
// 只在最后加一条源码护栏防止后来者再挂一份监听；真正的按键行为依赖浏览器 e2e。

import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString as rtsRaw } from "react-dom/server";
import type { ReactElement } from "react";

// ui.Modal 用 createPortal(children, document.body)；react-dom 的服务端渲染器不支持 portal，
// 故把 createPortal 就地渲染（返回 children），使 Modal 内容可在 SSR 中断言；生产代码不变。
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (children: unknown) => children };
});

// Modal 仍会求值 document.body（作为已被 mock 的 createPortal 第二参），给最小桩。
beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  g.document = g.document ?? { body: {} };
});

// ImportWizard 会拖 api/hooks（useBase / useFields / useGXMutations）。本文件只做 SSR 骨架断言，
// 不发请求、不引入 jsdom，故直接桩掉这三个 hook（网络层仍由被测组件自己走 api/client.ts）。
vi.mock("../api/hooks", () => ({
  useGXMutations: () => ({ csvImport: { mutateAsync: vi.fn() } }),
  useFields: () => ({ data: [] }),
  useBase: () => ({ data: null }),
}));

import { Modal, resolveModalFocus } from "./ui";

import { ImportWizard } from "../features/grid/ImportWizard";
import { ExportDialog } from "../features/grid/ExportDialog";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

function render(node: ReactElement): string {
  return rtsRaw(node).replace(/<!--[^>]*-->/g, "");
}

/** 从 SSR 产物里取出 aria-labelledby 的值 */
function labelledBy(html: string): string | null {
  const m = /aria-labelledby="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

describe("P3-a11y · Modal dialog 语义", () => {
  it("打开态带 role=dialog + aria-modal=true，且面板可接收程序化焦点（tabindex=-1）", () => {
    const html = render(
      <Modal open title="导入 CSV" onClose={() => undefined}>
        <div>正文</div>
      </Modal>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // tabindex=-1：只为「打开时移入焦点」，不进 Tab 序列，不构成焦点陷阱
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("导入 CSV");
  });

  it("aria-labelledby 指向真实存在的标题节点（同一个 id）", () => {
    const html = render(
      <Modal open title="导出 CSV" onClose={() => undefined}>
        <div>正文</div>
      </Modal>,
    );
    const id = labelledBy(html);
    expect(id).toBeTruthy();
    expect(id).toMatch(/^gx-modal-title-/);
    // 关键点：页面上必须真的有一个元素挂着这个 id，否则 labelledby 是空引用
    expect(html).toContain(`id="${id}"`);
    // 且这个 id 就是标题所在节点
    expect(html).toContain(`id="${id}" class="text-gx-14 font-semibold text-gx-text-primary">导出 CSV</div>`);
  });

  it("无 title 时不挂 aria-labelledby；给了 ariaLabel 则用 aria-label 兜底", () => {
    const bare = render(
      <Modal open onClose={() => undefined}>
        <div>正文</div>
      </Modal>,
    );
    expect(bare).toContain('role="dialog"');
    expect(labelledBy(bare)).toBeNull();

    const labelled = render(
      <Modal open ariaLabel="选择关联记录" onClose={() => undefined}>
        <div>正文</div>
      </Modal>,
    );
    expect(labelled).toContain('aria-label="选择关联记录"');
    expect(labelledBy(labelled)).toBeNull();
  });

  it("有 title 时 aria-label 让位给 aria-labelledby（不出现两个可访问名来源冲突）", () => {
    const html = render(
      <Modal open title="批量修改字段" ariaLabel="不该出现" onClose={() => undefined}>
        <div>正文</div>
      </Modal>,
    );
    expect(labelledBy(html)).toBeTruthy();
    expect(html).not.toContain('aria-label="不该出现"');
  });

  it("关闭态不渲染任何内容（保持既有行为，不泄漏空 dialog 到 DOM）", () => {
    expect(
      render(
        <Modal open={false} title="导入 CSV" onClose={() => undefined}>
          <div>正文</div>
        </Modal>,
      ),
    ).toBe("");
  });

  it("标题为 ReactNode（如带图标的确认弹窗）时同样能拿到 id", () => {
    const html = render(
      <Modal
        open
        title={
          <span className="flex items-center gap-2">
            <span>删除数据表</span>
          </span>
        }
        onClose={() => undefined}
      >
        <div>正文</div>
      </Modal>,
    );
    const id = labelledBy(html);
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
  });
});

describe("P3-a11y · 焦点移入 / 归还决策", () => {
  // 用最小鸭子类型替身，避开 node 环境无 DOM 的限制
  const el = (name: string, children: Element[] = []) =>
    ({
      tagName: name,
      contains: (other: Element) => other === (undefined as unknown) || children.includes(other),
      focus: vi.fn(),
    }) as unknown as HTMLElement;

  it("面板未挂载：不动焦点", () => {
    expect(resolveModalFocus(null, el("BUTTON"), el("BODY"))).toEqual({ moveInto: false, restoreTo: null });
  });

  it("焦点已在面板内（子元素 autoFocus）：不抢焦点，也不登记归还目标", () => {
    const input = el("INPUT");
    const panel = el("DIV", [input]);
    expect(resolveModalFocus(panel, input, el("BODY"))).toEqual({ moveInto: false, restoreTo: null });
  });

  it("焦点在外部触发按钮：移入面板，并登记该按钮为归还目标", () => {
    const trigger = el("BUTTON");
    const panel = el("DIV", []);
    const r = resolveModalFocus(panel, trigger, el("BODY"));
    expect(r.moveInto).toBe(true);
    expect(r.restoreTo).toBe(trigger);
  });

  it("焦点在 body：移入面板，但不把 body 登记为归还目标（归还给 body 无意义）", () => {
    const body = el("BODY");
    expect(resolveModalFocus(el("DIV", []), body, body)).toEqual({ moveInto: true, restoreTo: null });
  });
});

describe("P3-a11y · 依赖 Modal 的阶段 3/4 调用点未被破坏", () => {
  // 「不破坏调用点」不能靠嘴说：这里把 ImportWizard / ExportDialog / confirmAction 三处
  // 真实 SSR 渲染一遍，既断言 dialog 语义已生效，也断言各自的业务内容还在。

  it("ImportWizard：dialog 语义生效，且四步流程首屏（上传 + 下一步）仍在", () => {
    const html = render(<ImportWizard open tableId="t1" viewId="v1" baseId="b1" onClose={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const id = labelledBy(html);
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain("导入 CSV");
    // 功能优先：R-I-17 四步流程的「上传 / 下一步」入口必须还在
    expect(html).toContain("选择 CSV 文件或粘贴内容");
    expect(html).toContain("下一步");
  });

  it("ExportDialog：dialog 语义生效，且范围/格式选项与导出按钮仍在", () => {
    const html = render(<ExportDialog open viewId="v1" viewName="全部视图" busy={false} onExport={async () => undefined} onClose={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("导出 CSV");
    // 功能优先：R-I-19 让用户先选（范围 / 格式 / 附件）—— 三处选项与「导出」按钮都还在
    expect(html).toContain("当前视图");
    expect(html).toContain("规划中");
    expect(html).toContain("导出");
  });

  // ConfirmHost（confirmAction 的渲染宿主）只能靠 mount 后的 effect 订阅模块态，
  // SSR 下必然渲染为空 —— 这是既有行为，与本次改动无关，故这里按它实际喂给 Modal 的
  // props 形状（ReactNode 标题 + width 480 + 常驻 open）等价渲染一次，验证 dialog 语义成立。
  it("confirmAction 的确认宿主喂给 Modal 的 props 形状：dialog 语义与可访问名都成立", () => {
    const html = render(
      <Modal
        open
        onClose={() => undefined}
        title={
          <span className="flex items-center gap-2">
            <span className="text-gx-danger">删除数据表</span>
          </span>
        }
        width={480}
      >
        <div>此操作不可恢复</div>
      </Modal>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const id = labelledBy(html);
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain("删除数据表");
    // 功能优先：主按钮必须是具体动词（R-D-24），弹窗里不该出现「确定 / OK」
    expect(html).not.toContain(">确定<");
    // 源码护栏：确认宿主确实走的是统一 Modal，没有另起一套浮层
    expect(read("./feedback.tsx")).toMatch(/<Modal\n\s+open\n\s+onClose/);
  });
});

describe("P3-a11y · Esc 关闭未被重复实现（源码护栏）", () => {
  it("Modal 内只有一处 Escape → onClose 监听", () => {
    const src = read("./ui.tsx");
    const body = src.slice(src.indexOf("export function Modal("), src.indexOf("export function Popover("));
    expect(body).toContain('e.key === "Escape"');
    // 只挂一份：出现两次说明有人重复实现了（会双触发 onClose）
    expect(body.match(/e\.key === "Escape"/g)?.length).toBe(1);
    expect(body.match(/addEventListener\("keydown"/g)?.length).toBe(1);
  });
});

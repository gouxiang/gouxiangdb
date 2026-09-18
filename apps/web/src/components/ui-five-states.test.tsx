// 阶段 3 组件五态 + Toast 分级回归（node 环境，react-dom/server，无 jsdom、无新增依赖）。
//
// 锁的是「阶段 3 之后不允许回退」：
//   R-D-05  控件圆角 8（rounded-gx-lg），不再有 6（rounded-gx-md）
//   R-D-06  页面内按钮无阴影（阴影只有浮层能用）
//   R-D-07  次按钮底 #F4F6FA（bg-gx-control）+ 字 #2A3550
//   R-D-08  悬停：主按钮 brightness-95 不换色号；次按钮 / 行 #F1F5FB
//   R-D-09  禁用 = opacity .5 + 保持原色号 + title 说明原因
//   R-D-10  加载 = spinner 且保留按钮宽度
//   R-D-11  只读 = 去边框去底色 + 不用 disabled（内容仍可选中复制）
//   焦点态   可见 focus ring 且走 gx-accent
//   R-D-20  Toast 右下角 + 圆角 8 + 最多 3 条
//   R-D-22  撤销 toast 窗口 6s
//   R-D-34  只用颜色不足以表达状态：字符符号不得当功能图标

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  MenuItem,
  Select,
  Textarea,
  ToastHost,
  toast,
  toastSnapshot,
  dismissToast,
  TOAST_MAX,
  TOAST_UNDO_MS,
  TOAST_ERROR_MS,
  TOAST_SUCCESS_MS,
} from "./ui";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("阶段3 · Button 五态（R-D-07~10）", () => {
  it("默认：主按钮 accent 底白字；次按钮 control(#F4F6FA) 底 + text-secondary", () => {
    const primary = renderToStaticMarkup(<Button variant="primary">新建记录</Button>);
    expect(primary).toContain("bg-gx-accent");
    expect(primary).toContain("text-white");

    const secondary = renderToStaticMarkup(<Button variant="secondary">筛选</Button>);
    expect(secondary).toContain("bg-gx-control");
    expect(secondary).toContain("text-gx-text-secondary");
    // 次按钮不再是白底
    expect(secondary).not.toMatch(/bg-gx-surface\b/);
  });

  it("R-D-08 悬停：主按钮 brightness-95 不换色号；次按钮换 row-hover", () => {
    const primary = renderToStaticMarkup(<Button variant="primary">x</Button>);
    expect(primary).toContain("hover:brightness-95");
    const secondary = renderToStaticMarkup(<Button variant="secondary">x</Button>);
    expect(secondary).toContain("hover:bg-gx-row-hover");
  });

  it("R-D-09 禁用：opacity .5 + 保持原色号 + title 说明原因（不得灰色化 / 改底色）", () => {
    const html = renderToStaticMarkup(
      <Button variant="primary" disabled disabledReason="请先填写必填项">
        保存
      </Button>,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("disabled:opacity-50");
    expect(html).toContain("disabled:cursor-not-allowed");
    expect(html).toContain('title="请先填写必填项"');
    // 禁用态仍保留 accent 底色（只降透明度）
    expect(html).toContain("bg-gx-accent");
    // 不得出现灰色化底/字
    expect(html).not.toContain("disabled:bg-");
    expect(html).not.toContain("disabled:text-");
  });

  it("R-D-10 加载：spinner 出现且保留按钮宽度（文案继续占位）", () => {
    const html = renderToStaticMarkup(
      <Button variant="primary" loading>
        保存修改
      </Button>,
    );
    expect(html).toContain("animate-spin");
    expect(html).toContain("保存修改");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
  });

  it("焦点态：可见 focus ring 且走 gx-accent", () => {
    const html = renderToStaticMarkup(<Button>x</Button>);
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("focus-visible:ring-gx-accent");
  });

  it("R-D-05 控件圆角 8：三档尺寸全部 rounded-gx-lg，不再出现 rounded-gx-md/sm", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const html = renderToStaticMarkup(<Button size={size}>x</Button>);
      expect(html).toContain("rounded-gx-lg");
    }
    const html = renderToStaticMarkup(<Button>x</Button>);
    expect(html).not.toContain("rounded-gx-md");
    expect(html).not.toContain("rounded-gx-sm");
  });

  it("R-D-06 页面内按钮无阴影（阴影只有浮层能用）", () => {
    const primary = renderToStaticMarkup(<Button variant="primary">x</Button>);
    expect(primary).not.toMatch(/shadow-/);
    const icon = renderToStaticMarkup(<IconButton icon="close" label="关闭" />);
    expect(icon).not.toMatch(/shadow-/);
  });
});

describe("阶段3 · Input / Textarea / Select 五态（R-D-09/R-D-11）", () => {
  it("默认 + 悬停 + 焦点：边框 → hover 加深 → focus 转 accent 且带 ring", () => {
    const html = renderToStaticMarkup(<Input placeholder="邮箱" />);
    expect(html).toContain("rounded-gx-lg");
    expect(html).toContain("border-gx-border");
    expect(html).toContain("hover:border-gx-border-strong");
    expect(html).toContain("focus:ring-gx-accent");
    expect(html).toContain("focus:border-gx-accent");
  });

  it("R-D-11 只读：去边框去底色 + 三级字色，且**不用 disabled**（内容仍可选中复制）", () => {
    const html = renderToStaticMarkup(<Input readOnly value="不可编辑但可复制" />);
    expect(html).toContain('readonly=""');
    expect(html).not.toContain("disabled");
    expect(html).toContain("border-0");
    expect(html).toContain("bg-transparent");
    expect(html).toContain("text-gx-text-tertiary");
    expect(html).toContain('aria-readonly="true"');
  });

  it("禁用：opacity .5 保持原色 + title 说明原因", () => {
    const html = renderToStaticMarkup(<Input disabled disabledReason="只读角色不可编辑" />);
    expect(html).toContain("disabled:opacity-50");
    expect(html).toContain('title="只读角色不可编辑"');
    // 禁用仍保留默认框体色（不灰色化）
    expect(html).toContain("bg-gx-surface");
  });

  it("Select 与 Textarea 同样支持只读 / 禁用 / 圆角 8", () => {
    const sel = renderToStaticMarkup(<Select readOnly options={[{ value: "a", label: "A" }]} />);
    expect(sel).toContain("border-0");
    expect(sel).toContain('aria-readonly="true"');
    expect(sel).toContain("rounded-gx-lg");
    const ta = renderToStaticMarkup(<Textarea readOnly value="x" />);
    expect(ta).toContain("border-0");
    expect(ta).toContain("bg-transparent");
  });
});

describe("阶段3 · Menu 五态（R-D-08/R-D-09）", () => {
  it("菜单项 hover 走 row-hover，禁用 opacity .5 + title 原因，且有焦点环", () => {
    const html = renderToStaticMarkup(<MenuItem label="删除" danger disabled disabledReason="只读角色不可删除" />);
    expect(html).toContain("disabled:opacity-50");
    expect(html).toContain('title="只读角色不可删除"');
    expect(html).toContain("hover:bg-gx-danger-bg");
    expect(html).toContain("focus-visible:ring-gx-accent");
    const normal = renderToStaticMarkup(<MenuItem label="复制" />);
    expect(normal).toContain("hover:bg-gx-row-hover");
  });
});

describe("阶段3 · Toast（R-D-20~22）", () => {
  it("R-D-20 同屏最多 3 条：超出挤掉最旧的", () => {
    for (const item of toastSnapshot()) dismissToast(item.id);
    for (let i = 1; i <= 5; i++) toast(`第 ${i} 条`, "info");
    const snap = toastSnapshot();
    expect(snap.length).toBe(TOAST_MAX);
    expect(snap.map((s) => s.message)).toEqual(["第 3 条", "第 4 条", "第 5 条"]);
  });

  it("R-D-22 撤销 toast 窗口 6 秒；成功 2.5s；错误 4s", () => {
    for (const item of toastSnapshot()) dismissToast(item.id);
    const undoId = toast("已删除「接口规范 v2」", {
      kind: "success",
      action: { label: "撤销", onClick: () => undefined },
    });
    expect(toastSnapshot().find((t) => t.id === undoId)?.duration).toBe(TOAST_UNDO_MS);
    expect(toastSnapshot().find((t) => t.id === undoId)?.hasAction).toBe(true);
    expect(TOAST_UNDO_MS).toBe(6000);

    const okId = toast("已保存", "success");
    expect(toastSnapshot().find((t) => t.id === okId)?.duration).toBe(TOAST_SUCCESS_MS);
    const errId = toast("保存失败", "error");
    expect(toastSnapshot().find((t) => t.id === errId)?.duration).toBe(TOAST_ERROR_MS);
  });

  it("R-D-20 位置右下角 + 圆角 8 + 最大宽度 360（桌面）", () => {
    toast("定位断言", "info");
    const html = renderToStaticMarkup(<ToastHost />);
    // SSR 下 items 初始为空（useEffect 不跑），故只断言容器样式写在源码里
    expect(read("./ui.tsx")).toMatch(/sm:bottom-6/);
    expect(read("./ui.tsx")).toMatch(/sm:right-6/);
    expect(read("./ui.tsx")).toMatch(/max-w-\[360px\]/);
    expect(read("./ui.tsx")).toMatch(/rounded-gx-lg/);
    expect(html).toBe("");
  });

  it("旧签名 toast(msg, 'success') 仍可用（266 处调用点不破坏）", () => {
    for (const item of toastSnapshot()) dismissToast(item.id);
    const id = toast("已删除记录", "success");
    const snap = toastSnapshot();
    expect(snap.find((t) => t.id === id)?.kind).toBe("success");
  });
});

describe("阶段3 · 空态（R-D-13/R-D-14）", () => {
  it("R-D-13 首次空态：图标 + 主文案 + 次文案 + 主行动入口，四要素齐备", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon="table"
        title="暂无记录"
        description="点击「新建记录」开始添加数据。"
        action={<Button variant="primary">新建记录</Button>}
      />,
    );
    expect(html).toContain('data-gx-empty="first"');
    expect(html).toContain("暂无记录");
    expect(html).toContain("点击「新建记录」开始添加数据。");
    expect(html).toContain("新建记录");
  });

  it("R-D-14 筛选空态：固定文案 + 清除筛选，且不显示新建按钮", () => {
    const html = renderToStaticMarkup(<EmptyState kind="filtered" onClearFilters={() => undefined} />);
    expect(html).toContain('data-gx-empty="filtered"');
    expect(html).toContain("没有匹配的内容");
    expect(html).toContain("换个关键词试试");
    expect(html).toContain("清除筛选");
    expect(html).not.toContain("新建");
  });
});

describe("阶段3 · 字符符号不得当功能图标（R-D-34）", () => {
  it("源码里不再出现对勾/叉号/锁形这类字符符号（U+2713 / U+2715 / U+1F512）", () => {
    const files = [
      "../features/designer/RecordFilterBuilder.tsx",
      "../features/cells/format.ts",
      "../features/cells/CellEditor.tsx",
      "../features/kb/kb.css",
      "../features/designer/FieldEditorSheet.tsx",
      "../features/detail/FieldSettingsPanel.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src).not.toMatch(/[\u2713\u2714\u2715\u2716\u2717\u2718\u00D7]/);
      expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it("锁形 emoji 换成 icons.tsx 的 lock 图形（内联 SVG mask，跟 currentColor）", () => {
    const css = read("../features/kb/kb.css");
    expect(css).toMatch(/\.md-link-forbidden::after/);
    expect(css).toContain("mask:");
    expect(css).toContain("data:image/svg+xml");
    // lock 图标的两条 path 与 icons.tsx 一致
    expect(css).toContain("M6 11h12v10H6z");
    expect(css).toContain("M9 11V7a3 3 0 0 1 6 0v4");
  });
});

describe("阶段3 · 全局圆角统一（B1）", () => {
  it("apps/web/src 下不再有 rounded-gx-md（避免 6 / 8 两套圆角并存）", async () => {
    const { execSync } = await import("node:child_process");
    const out = execSync('grep -rn "rounded-gx-md" src/ || true', {
      cwd: new URL("../..", import.meta.url).pathname,
      encoding: "utf8",
    });
    // 排除本测试文件自身（里面只是断言用的字符串常量）
    const hits = String(out)
      .split("\n")
      .filter((l) => l.trim() && !l.includes(".test."));
    expect(hits).toEqual([]);
  });
});

describe("阶段3 · 字号令牌补齐（F1）", () => {
  it("令牌与 Tailwind 都注册了 15 这一档（R-D-02 九档含 15）", () => {
    const layout = read("../../../../packages/design-tokens/src/layout.ts");
    const tw = read("../../../../packages/design-tokens/src/tailwind.ts");
    expect(layout).toMatch(/x15:\s*15/);
    expect(tw).toMatch(/"gx-15":\s*\[/);
  });

  it("业务侧 text-gx-15 不再是未注册的静默无效类", () => {
    const html = renderToStaticMarkup(<span className="text-gx-15">标题</span>);
    expect(html).toContain("text-gx-15");
    const tw = read("../../../../packages/design-tokens/src/tailwind.ts");
    expect(tw).toContain("gx-15");
  });
});

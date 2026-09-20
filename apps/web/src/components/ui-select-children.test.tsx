// H-160 回归：自研 <Select> 不能吃掉调用方以 JSX children 方式传入的 <option>。
//
// 背景缺陷：Select 渲染体只输出 groups / options 两个 prop，children 留在 rest 里经
// {...rest} 传给 <select>，但 JSX 标签内的显式 children 优先级高于 props.children，
// 于是被 groups/options 的 map 结果覆盖 —— 两者都没传时渲染出空下拉，且无报错。
// 唯一受害点：CSV 导入向导「字段映射」步骤（ImportWizard.tsx:307）。
//
// 本文件锁三件事：
//   1. 传 options / groups 时行为与改造前逐字一致（全仓大量调用点依赖）；
//   2. 只传 children 时 children 必须真的渲染出来（不是空 <select>）；
//   3. 优先级 groups > options > children；
//   4. <select> 内不得出现杂散文本节点（防「在 JSX children 里写 // 注释」这类回潮）。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Select } from "./ui";

const OPTIONS = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙", disabled: true },
];

const GROUPS = [
  { label: "组一", options: [{ value: "g1", label: "一之一" }] },
  { label: "组二", options: [{ value: "g2", label: "二之一" }] },
];

const CHILDREN = (
  <>
    <option value="">自动匹配</option>
    <option value="f1">字段一</option>
  </>
);

/** 取出 <select ...> 开标签之后、</select> 之前的主体，便于断言 option 内容。 */
function body(html: string): string {
  const m = /^<select[^>]*>([\s\S]*)<\/select>$/.exec(html);
  if (!m) throw new Error(`不是单个 <select> 输出：${html}`);
  return m[1];
}

describe("H-160 · Select children 不被吞（回归）", () => {
  it("只传 children（无 options/groups）：children 的 option 真实渲染出来", () => {
    const html = renderToStaticMarkup(
      <Select value="" onChange={() => {}}>
        {CHILDREN}
      </Select>,
    );
    const b = body(html);
    expect(b).toContain('>自动匹配</option>');
    expect(b).toContain('<option value="f1">字段一</option>');
    // 缺陷态的判据：空下拉（没有任何 option）
    expect(b.match(/<option/g)?.length).toBe(2);
  });

  it("只传 options：行为与改造前一致（逐字，含 disabled 透传）", () => {
    const html = renderToStaticMarkup(<Select options={OPTIONS} />);
    const b = body(html);
    expect(b).toBe(
      '<option value="a">甲</option><option value="b" disabled="">乙</option>',
    );
  });

  it("只传 groups：渲染 optgroup，行为与改造前一致", () => {
    const html = renderToStaticMarkup(<Select groups={GROUPS} />);
    const b = body(html);
    expect(b).toBe(
      '<optgroup label="组一"><option value="g1">一之一</option></optgroup>' +
        '<optgroup label="组二"><option value="g2">二之一</option></optgroup>',
    );
    expect(b).not.toContain("自动匹配");
  });

  it("优先级：groups > options > children（同时传时只渲染胜出者）", () => {
    const g = body(
      renderToStaticMarkup(
        <Select groups={GROUPS} options={OPTIONS}>
          {CHILDREN}
        </Select>,
      ),
    );
    expect(g).toContain("<optgroup");
    expect(g).not.toContain('value="a"');
    expect(g).not.toContain("自动匹配");

    const o = body(
      renderToStaticMarkup(
        <Select options={OPTIONS}>{CHILDREN}</Select>,
      ),
    );
    expect(o).toContain('<option value="a">甲</option>');
    expect(o).not.toContain("<optgroup");
    expect(o).not.toContain("自动匹配");
  });

  it("空数组 options 仍按「已传 prop」处理（不落到 children）", () => {
    const b = body(renderToStaticMarkup(<Select options={[]}>{CHILDREN}</Select>));
    expect(b).toBe("");
  });

  it("<select> 主体内不得出现杂散文本（防 JSX 里 // 注释被当文本渲染）", () => {
    for (const html of [
      renderToStaticMarkup(<Select options={OPTIONS} />),
      renderToStaticMarkup(<Select groups={GROUPS} />),
      renderToStaticMarkup(<Select>{CHILDREN}</Select>),
    ]) {
      // 剥掉合法的 option/optgroup 元素后，不应残留任何非空白文本节点
      const stripped = body(html)
        .replace(/<option[^>]*>[\s\S]*?<\/option>/g, "")
        .replace(/<\/?optgroup[^>]*>/g, "")
        .trim();
      expect(stripped).toBe("");
      // 直接堵死「在 JSX children 区写 // 行注释」这类回潮（会被当文本渲染）
      expect(body(html)).not.toContain("//");
    }
  });

  it("children 路径同样保留 readOnly / disabledReason 语义", () => {
    const html = renderToStaticMarkup(
      <Select readOnly disabledReason="只读角色不可编辑">{CHILDREN}</Select>,
    );
    expect(html).toContain('aria-readonly="true"');
    expect(html).toContain('data-gx-readonly="true"');
    expect(html).toContain("border-0");
    expect(body(html)).toContain('<option value="f1">字段一</option>');

    const dis = renderToStaticMarkup(
      <Select disabled disabledReason="只读角色不可编辑">{CHILDREN}</Select>,
    );
    expect(dis).toContain('title="只读角色不可编辑"');
    expect(body(dis)).toContain('<option value="f1">字段一</option>');
  });
});

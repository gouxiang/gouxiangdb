// Switch 圆点定位回归（node + react-dom/server，沿用 ui 组件测试约定，无 jsdom/新依赖）。
// 锁 0.2.6 真机缺陷：圆点缺 left-0 时，绝对定位元素在 left:auto 下静态位置跟随祖先
// text-align；右对齐行（flex justify-between）会把圆点推到轨道右端，开态 translate-x-4 溢出。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Switch } from "./ui";

function knobClass(html: string): string {
  const m = html.match(/<span class="([^"]*absolute[^"]*)"/);
  if (!m) throw new Error("未找到圆点 span：" + html.slice(0, 200));
  return m[1];
}

describe("Switch 圆点定位", () => {
  it("关态：圆点含 left-0 + translate-x-0.5，不含 translate-x-4", () => {
    const html = renderToStaticMarkup(
      <Switch checked={false} onChange={() => {}} />,
    );
    const cls = knobClass(html);
    expect(cls).toContain("left-0");
    expect(cls).toContain("translate-x-0.5");
    expect(cls).not.toContain("translate-x-4");
  });

  it("开态：圆点含 left-0 且 translate-x-4 位移 1rem（不再因 left:auto 溢出）", () => {
    const html = renderToStaticMarkup(
      <Switch checked={true} onChange={() => {}} />,
    );
    const cls = knobClass(html);
    expect(cls).toContain("left-0");
    expect(cls).toContain("translate-x-4");
    expect(cls).not.toContain("translate-x-0.5");
  });

  it("右对齐 flex 容器（text-right + justify-between）里圆点仍锚定 left-0（防回归锚点）", () => {
    const html = renderToStaticMarkup(
      <div className="text-right">
        <div className="flex justify-between">
          <Switch checked={false} onChange={() => {}} />
        </div>
      </div>,
    );
    expect(knobClass(html)).toContain("left-0");
  });
});

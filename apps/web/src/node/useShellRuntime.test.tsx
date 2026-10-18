// useShellRuntime SSR 冒烟（node + react-dom/server，无 jsdom/timer 假实现）：
// 仅锁 enabled=false（非壳）形态——status/info/error 全 null、refresh 为 noop、渲染不抛错、
// 不产生任何 invoke（shellBridge 在非壳环境调用必抛「不在桌面壳环境」）。
// enabled=true 的 effect 轮询/卸载清理路径依赖 DOM 定时器，无 jsdom 下不在此强测。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useShellRuntime } from "./useShellRuntime";

function Probe({ enabled }: { enabled: boolean }) {
  const rt = useShellRuntime(enabled);
  return React.createElement(
    "div",
    null,
    `status=${rt.status === null ? "null" : "set"} info=${rt.info === null ? "null" : "set"} error=${rt.error === null ? "null" : "set"}`,
  );
}

describe("useShellRuntime SSR", () => {
  it("enabled=false 首拍全 null 且不抛错", () => {
    const html = renderToStaticMarkup(React.createElement(Probe, { enabled: false }));
    expect(html).toContain("status=null");
    expect(html).toContain("info=null");
    expect(html).toContain("error=null");
  });

  it("enabled=true 的 SSR 首拍同样为全 null（effect 不在服务端执行）", () => {
    const html = renderToStaticMarkup(React.createElement(Probe, { enabled: true }));
    expect(html).toContain("status=null");
    expect(html).toContain("info=null");
  });
});

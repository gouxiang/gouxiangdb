// S5b-P2：锁 buildServerArgs 的透传形状——off（不传 cpuProf）时 argv 必须与接入前
// 字节一致（["dist/index.js"]），on 时恰好在 script 前插入四个 --cpu-prof 参数。
// 不起真实服务（那需要 dist/DB）；只测纯 argv 构造。

import { describe, it, expect } from "vitest";
import { buildServerArgs } from "../server.js";

describe("buildServerArgs（--cpu-prof 透传，S5b-P2）", () => {
  it("不传 cpuProf：argv 与接入前字节一致（仅 script 一项）", () => {
    expect(buildServerArgs("dist/index.js")).toEqual(["dist/index.js"]);
    expect(buildServerArgs("dist/index.js", undefined)).toEqual(["dist/index.js"]);
  });

  it("传入 cpuProf：script 前插 --cpu-prof / dir / name 三参数，受管 node 仍由调用方给", () => {
    expect(buildServerArgs("dist/index.js", { dir: "/tmp/out/cpu-prof", name: "10k.read" })).toEqual([
      "--cpu-prof",
      "--cpu-prof-dir=/tmp/out/cpu-prof",
      "--cpu-prof-name=10k.read",
      "dist/index.js",
    ]);
  });

  it("传入 cpuProf + preload：最前注入 --import=<SIGTERM 预加载>，再接三参数与 script", () => {
    expect(
      buildServerArgs("dist/index.js", { dir: "/tmp/o", name: "t.read" }, "/abs/cpu-prof-exit.mjs"),
    ).toEqual([
      "--import=/abs/cpu-prof-exit.mjs",
      "--cpu-prof",
      "--cpu-prof-dir=/tmp/o",
      "--cpu-prof-name=t.read",
      "dist/index.js",
    ]);
  });

  it("name/dir 原样透传不做转义拼接（路径由调用方保证安全）", () => {
    const a = buildServerArgs("s", { dir: "d", name: "tag.write" });
    expect(a.slice(0, 3)).toEqual(["--cpu-prof", "--cpu-prof-dir=d", "--cpu-prof-name=tag.write"]);
    expect(a[3]).toBe("s");
  });
});

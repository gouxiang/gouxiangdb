// apps/api/src/__tests__/version.test.ts
// 版本单源守卫：运行时 VERSION 必须等于根 package.json 的 version，
// 且不得是解析失败兜底值（0.0.0-dev）。
// 注：这里曾有一条「不得等于 0.2.0」的断言，那是 0.2.0 被当作历史漂移值的时期留下的，
// 版本正式升到 0.2.0 后该断言变成误报，已移除——漂移检测由上面「等于根 package.json」那条负责。

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootPkgPath = path.resolve(here, "../../../../package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8")) as {
  name: string;
  version: string;
};

describe("VERSION 单源", () => {
  it("根 package.json name 为 gouxiangdb-v2", () => {
    expect(rootPkg.name).toBe("gouxiangdb-v2");
  });

  it("VERSION 等于根 package.json 的 version", () => {
    expect(VERSION).toBe(rootPkg.version);
  });

  it("不是解析失败兜底值", () => {
    expect(VERSION).not.toBe("0.0.0-dev");
  });

  it("符合 semver x.y.z 形态（允许 -prerelease / +build）", () => {
    // 根版本号默认保持纯 x.y.z（Cargo 与 macOS CFBundleVersion 不接受 +build）；
    // 构建短串只落在 git tag 名与 Release 名，不写进代码内版本号。
    // 此正则仍兼容 -prerelease / +build 形态；字符集与 packages/shared-types/src/update.ts 的 VERSION_RE 对齐。
    expect(VERSION).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    );
  });
});

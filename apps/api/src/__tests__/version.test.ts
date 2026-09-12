// apps/api/src/__tests__/version.test.ts
// 版本单源守卫：运行时 VERSION 必须等于根 package.json 的 version，
// 且不得残留历史漂移值（0.2.0）或解析失败兜底值（0.0.0-dev）。

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

  it("不是历史漂移值 0.2.0，也不是解析失败兜底值", () => {
    expect(VERSION).not.toBe("0.2.0");
    expect(VERSION).not.toBe("0.0.0-dev");
  });

  it("符合 semver x.y.z 形态", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

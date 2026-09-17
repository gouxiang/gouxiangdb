// M6/S2 zod4 隔离守卫（计划 §4.2）：`zod/v4` 只允许出现在 src/mcp/tools/schemas.ts。
//
// 背景：@modelcontextprotocol/sdk@1.30.0 自身 15 处 `from 'zod/v4'`（peer `zod ^3.25 || ^4.0` 由仓内
// zod 3.25.76 满足，其 `zod/v4` 子路径即 zod4 实现）。业务层继续用 zod3（`from "zod"`），两者不得混用；
// 若 zod4 扩散出 schemas.ts，工具入参校验语义会与业务层分叉，故用源码扫描守卫（CI/测试双保险）。

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");
const ALLOWED = path.resolve("src/mcp/tools/schemas.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue; // 守卫对象是生产源码（测试内可引用字面量）
      walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("zod4 隔离", () => {
  it("仅 src/mcp/tools/schemas.ts 允许 import zod/v4（其余 src 文件 0 命中）", () => {
    const offenders = walk(SRC)
      .filter((f) => /from\s+["']zod\/v4["']/.test(fs.readFileSync(f, "utf8")))
      .filter((f) => path.resolve(f) !== ALLOWED);
    expect(offenders).toEqual([]);
  });

  it("schemas.ts 确实使用 zod/v4（隔离点存在，非空守卫）", () => {
    expect(fs.readFileSync(ALLOWED, "utf8")).toMatch(/from\s+["']zod\/v4["']/);
  });

  it("业务层仍只用 zod3（src 内无 zod4 之外的 zod 子路径 import）", () => {
    const subpaths = new Set<string>();
    for (const f of walk(SRC)) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/from\s+["'](zod\/[^"']+)["']/g)) {
        subpaths.add(m[1]!);
      }
    }
    expect([...subpaths]).toEqual(["zod/v4"]); // 唯一允许的子路径形态
  });
});

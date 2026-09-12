// apps/api/src/version.ts
// 版本号单一来源：根 package.json（name=gouxiangdb-v2）的 version 是唯一真源。
// 取值顺序：构建期注入的 GX_VERSION（esbuild define）→ 开发/测试期上溯目录读根 package.json
// → 兜底 "0.0.0-dev"（dev 下告警一次，不吞错）。
// 本模块禁止 import db/config 等带副作用模块，保证测试与打包期可安全求值。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0-dev";

function readRootVersion(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === "gouxiangdb-v2" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // 损坏的 package.json 不应致命：继续上溯并最终走兜底分支。
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveVersion(): string {
  const injected = process.env.GX_VERSION;
  if (injected && injected.trim().length > 0) return injected.trim();
  const fromRoot = readRootVersion();
  if (fromRoot) return fromRoot;
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[version] 未能定位根 package.json（name=gouxiangdb-v2），版本回落为 0.0.0-dev",
    );
  }
  return FALLBACK_VERSION;
}

export const VERSION: string = resolveVersion();

// H-01 回归：帮助中心的配图静态路径不得与 SPA 路由 `/help` 重名（纯函数 + 产物布局断言）。
//
// 现象：浏览器直接访问 /help 报 403 Forbidden，只有 SPA 内点侧栏能进。
// 根因（VM 实测）：配图运行时副本放在 apps/web/public/help/assets/ → 部署根下出现
// **真实目录 help/**，而 /help 同时是帮助中心的 SPA 路由。静态层先于 SPA 回退处理：
//   GET /help      → 301 → /help/   （nginx 目录补全重定向）
//   GET /help/     → 403            （autoindex off，目录内无 index.html）
//   GET /x-y-z随机 → 200 index.html （没有真实路径时回退正常）
// 修法：静态目录改名 public/help-assets/ → 部署后 /help-assets/，与路由彻底不重名。

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HELP_ASSET_PATH } from "../help-html";

describe("H-01：配图静态路径不得与 SPA 路由 /help 重名", () => {
  it("HELP_ASSET_PATH 既不叫 /help/ 也不落在 /help/ 下", () => {
    expect(HELP_ASSET_PATH).not.toBe("/help/");
    expect(HELP_ASSET_PATH.startsWith("/help/")).toBe(false);
    expect(HELP_ASSET_PATH).toBe("/help-assets/");
  });

  it("vite 静态目录 public/ 下不存在名为 help 的一级目录（会原样落进部署根撞路由）", () => {
    // public/ 由 scripts/sync-help-center.mjs 重建，未跑过脚本时可能不存在 → 视为空
    let names: string[] = [];
    try {
      names = readdirSync(new URL("../../../../../public/", import.meta.url));
    } catch {
      names = [];
    }
    expect(names).not.toContain("help");
  });

  it("同步脚本的配图输出目录是 public/help-assets（真源 docs/help-center/assets 不变）", () => {
    const s = readFileSync(
      new URL("../../../../../../scripts/sync-help-center.mjs", import.meta.url),
      "utf8",
    );
    expect(s).toContain('"public", "help-assets"');
    // 真源仍从 docs/help-center/assets 拷，人工放图的位置不变
    expect(s).toContain('join(SRC_DIR, "assets")');
    expect(s).not.toContain('"public", "help", "assets"');
  });
});

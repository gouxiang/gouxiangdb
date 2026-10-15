// GX_SYNC_SERVER 总门解析纯函数测试（无 db/Hono，表驱动）。
// 设计权威：DESIGN-OFFLINE-SYNC §11.1——默认 off，只有显式 on/true/1 才开，笔误 fail-closed。

import { afterEach, describe, expect, it } from "vitest";
import { parseSyncServerFlag, syncServerEnabled } from "../configSync.js";

describe("parseSyncServerFlag", () => {
  it("默认关闭：undefined / 空串 / 纯空白", () => {
    expect(parseSyncServerFlag(undefined)).toBe(false);
    expect(parseSyncServerFlag("")).toBe(false);
    expect(parseSyncServerFlag("   ")).toBe(false);
  });

  it("只有 on/true/1（忽略大小写与首尾空白）才开", () => {
    for (const v of ["on", "ON", " On ", "true", "TRUE", "1", " 1 "]) {
      expect(parseSyncServerFlag(v)).toBe(true);
    }
  });

  it("笔误/其他值一律关闭（fail-closed）", () => {
    for (const v of ["off", "opn", "yes", "enabled", "0", "false", "2", "on/off"]) {
      expect(parseSyncServerFlag(v)).toBe(false);
    }
  });
});

describe("syncServerEnabled", () => {
  const prev = process.env.GX_SYNC_SERVER;
  afterEach(() => {
    if (prev === undefined) delete process.env.GX_SYNC_SERVER;
    else process.env.GX_SYNC_SERVER = prev;
  });

  it("未设置 -> false；on -> true；off -> false（运行时读 env，可进程内切换）", () => {
    delete process.env.GX_SYNC_SERVER;
    expect(syncServerEnabled()).toBe(false);
    process.env.GX_SYNC_SERVER = "on";
    expect(syncServerEnabled()).toBe(true);
    process.env.GX_SYNC_SERVER = "off";
    expect(syncServerEnabled()).toBe(false);
  });
});

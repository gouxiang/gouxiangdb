// 检索总门判定矩阵单测（纯函数，零 IO、零 db）。
//
// 锁的是权威顺序：**app_settings.search.enabled 显式 on/off > 环境变量 GX_M5_SEARCH > 默认 off**
// ——即后台显式设置后 env=off 也压不住它，只有 inherit 才回落 env（老库/未配置零变化）。
//
// 为什么单独成文件：本机无法稳定造出「env=off 且后台置 on」的真机态（dev 进程的环境变量在启动时
// 定型），而这条语义必须是可回归的——故用 db×env 全矩阵把它钉死，真机侧另有 HTTP 集成用例
// （routes/v1/__tests__/m5-search-gate.test.ts：env=off + db=on -> /api/v1/search 200）。
//
// 诚实口径同时锁死：queryAvailable 只由目标态决定；workerNeedsRestart 恒 true（worker 启动期决定）。

import { describe, expect, it } from "vitest";
import { parseM5SearchFlag } from "../../../configM5Search.js";
import { parseSearchEnabledOverride, resolveSearchGate } from "../searchGate.js";
import type { SearchEnabledOverride, SearchGateFlag } from "@gx/shared-types";

const ENVS: readonly SearchGateFlag[] = ["off", "shadow", "on"];
const OVERRIDES: readonly SearchEnabledOverride[] = ["on", "off", "inherit"];

describe("总门判定矩阵（db 覆盖 × env）", () => {
  // 九格全量：覆盖值显式时 env 说什么都不算；inherit 时完全跟随 env。
  const matrix: Array<[SearchEnabledOverride, SearchGateFlag, SearchGateFlag]> = [
    ["on", "off", "on"],
    ["on", "shadow", "on"],
    ["on", "on", "on"],
    ["off", "off", "off"],
    ["off", "shadow", "off"],
    ["off", "on", "off"],
    ["inherit", "off", "off"],
    ["inherit", "shadow", "shadow"],
    ["inherit", "on", "on"],
  ];

  for (const [override, env, effective] of matrix) {
    it(`override=${override} × env=${env} -> effective=${effective}`, () => {
      const r = resolveSearchGate(env, override);
      expect(r.effective).toBe(effective);
      // 检索接口恒挂载：目标态非 off 即对外可用（env=off 也不再是硬闸门）。
      expect(r.queryAvailable).toBe(effective !== "off");
      expect(r.envGateOff).toBe(env === "off");
      // worker 启动期决定，覆盖值对它恒需重启（不假装热切换）。
      expect(r.workerNeedsRestart).toBe(true);
    });
  }

  it("env 未设置 ≡ off：inherit 时目标态 off，显式 on 仍可打开（六格中的 unset 列）", () => {
    expect(parseM5SearchFlag(undefined)).toBe("off");
    expect(resolveSearchGate(parseM5SearchFlag(undefined), "inherit").effective).toBe("off");
    expect(resolveSearchGate(parseM5SearchFlag(undefined), "on")).toMatchObject({
      effective: "on",
      envGateOff: true,
      queryAvailable: true,
    });
  });

  it("核心回归：env=off 时后台置 on 必须压过 env（旧实现曾直接短路回 off）", () => {
    const r = resolveSearchGate("off", "on");
    expect(r.effective).toBe("on");
    expect(r.queryAvailable).toBe(true);
    // 但 env=off 这一事实仍要如实暴露给前端标注（"当前由环境变量关闭"那一行靠它）。
    expect(r.envGateOff).toBe(true);
  });

  it("覆盖值解析：仅精确小写 on/off 生效，其余一律 inherit（不报错）", () => {
    expect(parseSearchEnabledOverride("on")).toBe("on");
    expect(parseSearchEnabledOverride("OFF")).toBe("off");
    expect(parseSearchEnabledOverride(undefined)).toBe("inherit");
    expect(parseSearchEnabledOverride("yes")).toBe("inherit");
    for (const o of OVERRIDES) {
      for (const e of ENVS) {
        expect(["on", "off", "inherit"]).toContain(parseSearchEnabledOverride(o));
        expect(resolveSearchGate(e, o).effective === "off").toBe(o === "off" || (o === "inherit" && e === "off"));
      }
    }
  });
});

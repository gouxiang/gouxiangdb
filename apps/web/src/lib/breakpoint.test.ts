// 响应式断点档位回归（node 环境，纯函数，无 jsdom、无新增依赖）。
//
// 锁的是 UI-SPEC v1.0 §3.6（R-D-29~R-D-33）五档的**判定口径**：
//   1600 → 2xl（≥1440 完整三栏）｜1366 → xl（L2 恒 236，v6 S2 起不分档）｜1152 → lg（L2 浮出）｜
//   900  → md（L1 恒 76 图标轨 + L2 浮出 + 表格转卡片）｜390 → sm（抽屉 + 搜索折叠为图标）
// 档位值错一格，L2 宽度 / 抽屉 / 卡片列表就会整体错位，故逐档 + 边界都钉死。

import { describe, it, expect } from "vitest";
import { tierOfWidth, isDrawerTier, isFloatingL2Tier, TIER_MIN_WIDTH } from "./breakpoint";
import { L2_WIDTH } from "../features/workspace/lib/l1-collapse";
import { gxTailwindConfig } from "@gx/design-tokens/tailwind";

describe("R-D-29~33 五档判定（QA 走查档位）", () => {
  it("QA 五档：1600 / 1366 / 1152 / 900 / 390 分别落到 2xl / xl / lg / md / sm", () => {
    expect(tierOfWidth(1600)).toBe("2xl");
    expect(tierOfWidth(1366)).toBe("xl");
    expect(tierOfWidth(1152)).toBe("lg");
    expect(tierOfWidth(900)).toBe("md");
    expect(tierOfWidth(390)).toBe("sm");
  });

  it("边界值取闭下界：1440/1280/1024/768 归高一档，1439/1279/1023/767 归低一档", () => {
    expect(tierOfWidth(1440)).toBe("2xl");
    expect(tierOfWidth(1439)).toBe("xl");
    expect(tierOfWidth(1280)).toBe("xl");
    expect(tierOfWidth(1279)).toBe("lg");
    expect(tierOfWidth(1024)).toBe("lg");
    expect(tierOfWidth(1023)).toBe("md");
    expect(tierOfWidth(768)).toBe("md");
    expect(tierOfWidth(767)).toBe("sm");
    expect(tierOfWidth(0)).toBe("sm");
  });

  it("非法宽度（NaN）回落 sm：宁可按最窄档渲染，也不让抽屉/卡片判定失控", () => {
    expect(tierOfWidth(Number.NaN)).toBe("sm");
  });

  it("下界常量与规范一致（768 / 1024 / 1280 / 1440）", () => {
    expect(TIER_MIN_WIDTH).toEqual({ sm: 0, md: 768, lg: 1024, xl: 1280, "2xl": 1440 });
  });
});

describe("档位语义（壳层据此切换结构）", () => {
  it("<768 才是抽屉档；768–1279 是 L2 浮出档；≥1280 两者都不是", () => {
    expect(isDrawerTier("sm")).toBe(true);
    expect(isDrawerTier("md")).toBe(false);
    expect(isFloatingL2Tier("md")).toBe(true);
    expect(isFloatingL2Tier("lg")).toBe(true);
    expect(isFloatingL2Tier("xl")).toBe(false);
    expect(isFloatingL2Tier("2xl")).toBe(false);
  });

  it("v6 S2：L2 按底板恒定 236，1280–1439 紧凑档（208）已废止", () => {
    expect(L2_WIDTH).toBe(236);
  });
});

describe("Tailwind screens 与 JS 档位同源", () => {
  it("gxTailwindConfig 的 screens 五档与 TIER_MIN_WIDTH 对齐，2xl=1440（非默认 1536）", () => {
    const screens = gxTailwindConfig.theme?.extend?.screens as
      | Record<string, string>
      | undefined;
    expect(screens).toEqual({
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1440px",
    });
  });
});

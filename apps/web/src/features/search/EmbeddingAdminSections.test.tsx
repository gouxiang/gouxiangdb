// 检索总门分区（SearchGateSection）的 SSR 文案回归（node：react-dom/server，无新增依赖）。
//
// 锁的是「三态如实标注」——P3 把权威顺序改成 db 覆盖 > env 之后，env=off 不再代表"界面开不了"：
//   1. env=off 且后台未显式设置：必须明说"当前由环境变量关闭，可在上方开启"（不是甩一句改环境变量）；
//   2. env=off 但后台已置 on：如实说"已按后台设置启用"，且仍提醒索引 worker 需重启（不做假开关）；
//   3. 两行热切换口径（检索接口即时 / worker 需重启）恒在，改文案不许改掉。
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { SearchGateDTO } from "@gx/shared-types";
import { SearchGateSection } from "./EmbeddingAdminSections";

const text = (html: string): string =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function render(gate: SearchGateDTO, value: "on" | "off" | "inherit"): string {
  return text(renderToString(<SearchGateSection gate={gate} value={value} onChange={() => undefined} />));
}

const ENV_OFF: SearchGateDTO = {
  envValue: "off", override: "inherit", effective: "off",
  queryAvailable: false, envGateOff: true, workerNeedsRestart: true,
};
const ENV_ON: SearchGateDTO = {
  envValue: "on", override: "inherit", effective: "on",
  queryAvailable: true, envGateOff: false, workerNeedsRestart: true,
};

describe("检索总门三态标注", () => {
  it("env=off 且未显式设置：明说「当前由环境变量关闭，可在上方开启」", () => {
    const s = render(ENV_OFF, "inherit");
    expect(s).toContain("当前由环境变量关闭，可在上方将覆盖值设为「启用」打开");
    // 不许再出现旧口径"必须改 GX_M5_SEARCH 并重启"（那就是假开关）
    expect(s).not.toContain("需先改 GX_M5_SEARCH");
  });

  it("env=off 但后台置 on：如实标注已按后台启用，且仍提醒 worker 需重启", () => {
    const s = render({ ...ENV_OFF, override: "on", effective: "on", queryAvailable: true }, "on");
    expect(s).toContain("已按后台设置启用");
    expect(s).toContain("索引 worker");
  });

  it("热切换两行口径恒在：检索接口即时生效 / 索引 worker 需重启", () => {
    for (const g of [ENV_OFF, ENV_ON]) {
      const s = render(g, "inherit");
      expect(s).toContain("检索接口：覆盖值即时生效");
      expect(s).toContain("索引 worker：启动期决定是否运行");
    }
  });

  it("env 不为 off 时不出现「由环境变量关闭」那一行（不误导）", () => {
    expect(render(ENV_ON, "inherit")).not.toContain("当前由环境变量关闭");
  });
});

// update-copy 纯函数：通道名、大小/时间格式化、错误码映射 fail-closed。
import { describe, it, expect } from "vitest";
import {
  UPDATE_ERROR_MESSAGES,
  archLabel,
  channelLabel,
  formatDateTime,
  formatSize,
  updateErrorMessage,
} from "../update-copy";

describe("channelLabel / archLabel", () => {
  it("已知通道给中文名", () => {
    expect(channelLabel("fnos-fpk")).toBe("飞牛 fpk 成品包");
    expect(channelLabel("source-bare")).toBe("裸机源码部署");
    expect(channelLabel("desktop-client")).toBe("桌面客户端");
  });

  it("未知通道给「未识别」，不猜", () => {
    expect(channelLabel("totally-new")).toBe("未识别的部署方式");
  });

  it("架构拼接为 platform / arch", () => {
    expect(archLabel("linux", "x64")).toBe("linux / x64");
  });
});

describe("formatSize", () => {
  it("0 显示 1 KiB 起步（最小 1）", () => {
    expect(formatSize(0)).toBe("1 KiB");
  });
  it("不足 1 MiB 走 KiB", () => {
    expect(formatSize(2048)).toBe("2 KiB");
  });
  it("MiB 保留一位小数", () => {
    expect(formatSize(62_586_880)).toBe("59.7 MiB");
  });
  it("非法值兜底", () => {
    expect(formatSize(Number.NaN)).toBe("—");
    expect(formatSize(-1)).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("合法 ISO 转本地 YYYY-MM-DD HH:mm", () => {
    // 用确定性构造：直接断言格式（不锁定时区具体值）。
    const out = formatDateTime("2026-10-12T03:00:00.000Z");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it("空值/非法回退", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});

describe("updateErrorMessage 错误码映射", () => {
  const getCode = (e: unknown) =>
    e && typeof e === "object" && "code" in e ? ((e as { code?: unknown }).code as string | null) : null;

  it("五个源错误码逐字映射", () => {
    for (const code of [
      "UPDATE_SOURCE_UNCONFIGURED",
      "UPDATE_SOURCE_AUTH",
      "UPDATE_SOURCE_UNREACHABLE",
      "UPDATE_SOURCE_TIMEOUT",
      "UPDATE_MANIFEST_INVALID",
    ]) {
      expect(updateErrorMessage({ code }, getCode)).toBe(UPDATE_ERROR_MESSAGES[code]);
    }
  });

  it("票据失效 / 无更新可下载码有专属文案", () => {
    expect(updateErrorMessage({ code: "UPDATE_TICKET_INVALID" }, getCode)).toContain("下载链接已失效");
    expect(updateErrorMessage({ code: "UPDATE_NOT_AVAILABLE" }, getCode)).toContain("没有可下载的更新");
  });

  it("403 走非 owner 文案", () => {
    expect(updateErrorMessage({ status: 403 }, () => null)).toBe("仅工作区所有者可以检查更新");
  });

  it("无 status（网络层）给网络异常文案", () => {
    expect(updateErrorMessage(new Error("fetch failed"), () => null)).toContain("网络异常");
  });

  it("未知错误 fail-closed 兜底，不透出 body", () => {
    const msg = updateErrorMessage({ status: 500, code: "SOMETHING_INTERNAL" }, getCode);
    expect(msg).toBe("检查更新失败，请稍后重试");
  });
});

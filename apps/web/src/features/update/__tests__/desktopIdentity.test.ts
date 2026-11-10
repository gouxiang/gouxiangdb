// desktopIdentity.ts 单测（纯 node、无 jsdom、无新依赖）。
// 锁三件事：
//   I1 toDesktopUpdateIdentity 把壳桥词表逐字透传为更新身份（platform/arch 零转换，channel 固定）；
//   I2 非壳环境 resolveDesktopUpdateIdentity 恒 null，且【不触达】壳 IPC（现网零变化总闸）；
//   I3 壳在但 getShellInfo 失败时 fail-closed 回 null（退回无参现状，不阻断检查更新）。
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  __setShellBridgeForTest,
  __resetShellBridgeForTest,
  CMD,
  type ShellInfo,
} from "../../../node/shellBridge";
import {
  DESKTOP_UPDATE_CHANNEL,
  resolveDesktopUpdateIdentity,
  toDesktopUpdateIdentity,
} from "../desktopIdentity";

afterEach(() => {
  __resetShellBridgeForTest();
  vi.restoreAllMocks();
});

function shellInfo(over: Partial<ShellInfo> = {}): ShellInfo {
  return {
    shellVersion: "0.3.1",
    platform: "darwin",
    arch: "arm64",
    shellPort: 47831,
    launcher: true,
    ...over,
  };
}

describe("I1 toDesktopUpdateIdentity 纯函数：壳词表逐字透传、零转换", () => {
  const cases: Array<{ name: string; info: ShellInfo }> = [
    { name: "macOS arm64", info: shellInfo({ platform: "darwin", arch: "arm64" }) },
    { name: "macOS x64", info: shellInfo({ platform: "darwin", arch: "x64" }) },
    { name: "Windows x64", info: shellInfo({ platform: "win32", arch: "x64" }) },
    { name: "Linux x64", info: shellInfo({ platform: "linux", arch: "x64" }) },
    { name: "Linux arm64", info: shellInfo({ platform: "linux", arch: "arm64" }) },
  ];
  for (const c of cases) {
    it(`${c.name} → channel 固定 desktop-client，platform/arch 原样不转换`, () => {
      const id = toDesktopUpdateIdentity(c.info);
      expect(id).toEqual({
        channel: DESKTOP_UPDATE_CHANNEL,
        platform: c.info.platform,
        arch: c.info.arch,
      });
      expect(id.channel).toBe("desktop-client");
    });
  }

  it("不携带 shellVersion/shellPort/launcher 等壳内字段（只发更新 API 认识的三键）", () => {
    const id = toDesktopUpdateIdentity(shellInfo());
    expect(Object.keys(id).sort()).toEqual(["arch", "channel", "platform"]);
  });
});

describe("I2 非壳环境：恒 null 且不触达 IPC（现网零变化总闸）", () => {
  it("shellPresent=false：resolve 返回 null，invoke 一次都不被调用", async () => {
    const invoke = vi.fn().mockResolvedValue(shellInfo());
    __setShellBridgeForTest({ invoke, shellPresent: false });

    const id = await resolveDesktopUpdateIdentity();
    expect(id).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("显式复位走真实 window 检测（node harness 无 __TAURI_INTERNALS__）同样返回 null", async () => {
    __resetShellBridgeForTest();
    await expect(resolveDesktopUpdateIdentity()).resolves.toBeNull();
  });
});

describe("I3 壳内解析", () => {
  it("壳在且 getShellInfo 成功：以 gx:get_shell_info 取信息并收敛为更新身份", async () => {
    const invoke = vi.fn().mockResolvedValue(shellInfo({ platform: "darwin", arch: "arm64" }));
    __setShellBridgeForTest({ invoke, shellPresent: true });

    const id = await resolveDesktopUpdateIdentity();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(CMD.getShellInfo, undefined);
    expect(id).toEqual({ channel: "desktop-client", platform: "darwin", arch: "arm64" });
  });

  it("壳在但 IPC reject：fail-closed 回 null，不抛错（退回无参现状）", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("旧壳无此命令"));
    __setShellBridgeForTest({ invoke, shellPresent: true });

    await expect(resolveDesktopUpdateIdentity()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

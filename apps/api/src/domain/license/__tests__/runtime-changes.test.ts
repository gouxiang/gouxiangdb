/**
 * runtime -> 授权变更信号 连线测试（P2 回归保护）。
 *
 * 背景：后台心跳成功路径曾只清席位缓存、漏发信号，导致闸门②缓存 10s 不重算
 * （续费恢复白等、吊销方向 fail-open 尾巴）。本文件隔离一切重 IO（mock store/client/
 * identity/seats），只保留【真实 runtime + 真实 changes 信号】，驱动私有 tick 验证：
 *   - heartbeat ok  -> 发一次变更信号；
 *   - heartbeat 非 ok（5xx/网络）-> 不发信号（单据未变，不能误清/误触发）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hb = vi.hoisted(() => ({
  // 可逐用例切换的心跳结果；默认成功。
  outcome: { ok: true, status: 200 } as { ok: boolean; status: number },
}));

vi.mock("../kv.js", () => ({ prismaKv: {} }));

vi.mock("../store.js", () => ({
  LicenseStore: class {
    private maxSeen = 0;
    private intervalSec = 0;
    async getMaxSeen(): Promise<number> {
      return this.maxSeen;
    }
    async setMaxSeen(sec: number): Promise<void> {
      this.maxSeen = sec;
    }
    async getLastIntervalSec(fallback: number): Promise<number> {
      return this.intervalSec || fallback;
    }
    async setLastIntervalSec(sec: number): Promise<void> {
      this.intervalSec = sec;
    }
  },
}));

vi.mock("../deviceIdentity.js", () => ({
  resolveDeviceIdentity: vi.fn(async () => ({ identity: { platform: "darwin" } })),
}));

vi.mock("../seats.js", () => ({
  listSeatUsers: vi.fn(async () => ({ occupied: 0 })),
  invalidateSeatCache: vi.fn(),
  snapshotGrandfatheredOnce: vi.fn(async () => false),
}));

vi.mock("../client.js", () => ({
  LicenseClient: class {
    fingerprint = "fp-test";
    get currentBaseUrl(): string {
      return "http://127.0.0.1:8787";
    }
    async bootstrap(): Promise<void> {}
    async heartbeat(): Promise<{ ok: boolean; status: number }> {
      return hb.outcome;
    }
  },
}));

// 其余 tick 路径：clock/http/feedback 用无副作用桩即可，runtime 仅 new 不真正驱动它们。
vi.mock("../http.js", () => ({ FetchHttpTransport: class {}, isAllowedLicenseUrl: () => true }));

import { LicenseRuntime } from "../runtime.js";
import { parseLicenseConfig } from "../configLicense.js";
import { onLicenseChanged, __resetLicenseChangeSignal } from "../changes.js";

function makeRuntime(): LicenseRuntime {
  const dir = mkdtempSync(join(tmpdir(), "gx-rtchg-"));
  return new LicenseRuntime(parseLicenseConfig({ GX_LICENSE_MODE: "enforce" }, dir));
}

async function tick(rt: LicenseRuntime): Promise<void> {
  await (rt as unknown as { tick(): Promise<void> }).tick();
}

describe("LicenseRuntime 心跳成功 -> 发授权变更信号", () => {
  let off: () => void;
  let fires: number;

  beforeEach(() => {
    __resetLicenseChangeSignal();
    fires = 0;
    off = onLicenseChanged(() => {
      fires += 1;
    });
    hb.outcome = { ok: true, status: 200 };
  });

  afterEach(() => {
    off();
  });

  it("heartbeat 成功：发一次信号（驱动闸门②即时重算）", async () => {
    const rt = makeRuntime();
    await rt.start();
    await tick(rt);
    expect(fires).toBe(1);
    rt.stop();
  });

  it("heartbeat 失败（5xx 信封不可用）：不发信号，单据未变不得误触发", async () => {
    hb.outcome = { ok: false, status: 503 };
    const rt = makeRuntime();
    await rt.start();
    await tick(rt);
    expect(fires).toBe(0);
    rt.stop();
  });

  it("heartbeat 网络层失败（status=0）：不发信号", async () => {
    hb.outcome = { ok: false, status: 0 };
    const rt = makeRuntime();
    await rt.start();
    await tick(rt);
    expect(fires).toBe(0);
    rt.stop();
  });
});

// L2 收起态持久化单测（与 l1-collapse 同风格：node 环境 + vi.stubGlobal 造 window.localStorage）。
//
// 锁的是「用户意图 ≠ 响应式档位」这条根因：
//   · 未操作（键缺失）→ null，调用方按档位默认走；
//   · 显式收起/展开 → 跨刷新保持，且压过档位默认（resolveL2Collapsed）；
//   · localStorage 不可用 → 静默降级，不抛。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  L2_COLLAPSED_KEY,
  L2_WIDTH_COLLAPSED,
  readL2Collapsed,
  writeL2Collapsed,
  resolveL2Collapsed,
} from "./l2-collapse";

/** 造一个带 localStorage 的 window；seed 省略即「键从未写过」。 */
function stubWindow(seed?: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (seed !== undefined && seed !== null) map.set(L2_COLLAPSED_KEY, seed);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
    },
  });
  return map;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("L2 折叠档常量与键名", () => {
  it("键走 gx.l2.* 约定；窄条宽度自立常量 56（v6 S1：L1 折叠档废止，不再从 l1-collapse 取）", () => {
    expect(L2_COLLAPSED_KEY).toBe("gx.l2.collapsed");
    expect(L2_WIDTH_COLLAPSED).toBe(56);
  });
});

describe("readL2Collapsed 三态", () => {
  it("键缺失 → null（用户从未操作，交回档位默认）", () => {
    stubWindow();
    expect(readL2Collapsed()).toBeNull();
  });

  it("「1」收起 / 「0」展开；脏值按未操作处理，不当成展开", () => {
    stubWindow("1");
    expect(readL2Collapsed()).toBe(true);
    stubWindow("0");
    expect(readL2Collapsed()).toBe(false);
    stubWindow("yes");
    expect(readL2Collapsed()).toBeNull();
  });

  it("SSR（无 window）与 localStorage 抛错时都回落 null，不抛", () => {
    expect(readL2Collapsed()).toBeNull(); // 无 window
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => undefined,
      },
    });
    expect(readL2Collapsed()).toBeNull();
    expect(() => writeL2Collapsed(true)).not.toThrow();
  });
});

describe("writeL2Collapsed 往返与降级", () => {
  it("写入后可读回同一态；收起写「1」、展开写「0」", () => {
    const map = stubWindow();
    writeL2Collapsed(true);
    expect(map.get(L2_COLLAPSED_KEY)).toBe("1");
    expect(readL2Collapsed()).toBe(true);

    writeL2Collapsed(false);
    expect(map.get(L2_COLLAPSED_KEY)).toBe("0");
    expect(readL2Collapsed()).toBe(false);
  });

  it("setItem 抛错（隐私模式 / 配额满）静默不抛，退化为单次会话内有效", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(() => writeL2Collapsed(true)).not.toThrow();
  });
});

describe("resolveL2Collapsed 优先级：用户意图 > 档位默认", () => {
  it("无意图时跟随档位（浮出档收起 / 常驻档展开）", () => {
    expect(resolveL2Collapsed(null, true)).toBe(true);
    expect(resolveL2Collapsed(null, false)).toBe(false);
  });

  it("有意图时压过档位：窄屏手动展开不被覆盖、宽屏手动收起不被强开", () => {
    expect(resolveL2Collapsed(false, true)).toBe(false);
    expect(resolveL2Collapsed(true, false)).toBe(true);
  });
});

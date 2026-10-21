// YN9/S6-WEB-a · 离线 Yjs 累积层纯逻辑回归（node 环境，自带内存 localStorage，不依赖 jsdom）。
// 覆盖：append→load 往返、多 update merge 还原、灌入事务 local=false（不被二次回存的根因）、
// 确认后 clear、坏数据自愈不抛、超阈值压缩为快照、无 localStorage 安全 no-op、门控默认关。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendLocalUpdate,
  clearLocalUpdates,
  hasLocalUpdates,
  loadMergedLocalState,
  MAX_STORED_KEY_CHARS,
} from "../yOfflinePersistence";
import { isCollabBindingStatus, isYOfflineFlagEnabled, yOfflineEnabled } from "../yOfflineGate";

const ROOM = "doc:room-1";
const KEY = "gx-y:doc:room-1";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem = (k: string): string | null => this.map.get(k) ?? null;
  setItem = (k: string, v: string): void => void this.map.set(k, v);
  removeItem = (k: string): void => void this.map.delete(k);
  /** 测试用：直接写坏数据 / 读原始 JSON。 */
  setRaw(k: string, v: string): void {
    this.map.set(k, v);
  }
  getRaw(k: string): string | undefined {
    return this.map.get(k);
  }
  clear(): void {
    this.map.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  // @ts-expect-error 还原到无 localStorage（模拟 SSR）
  delete globalThis.localStorage;
});

/** 在一个新 Y.Doc 上产生对具名 Y.Text 的插入 update。 */
function textUpdate(seed: string, insert: string, at = 0): Uint8Array {
  const d = new Y.Doc();
  const t = d.getText("body");
  if (seed) t.insert(0, seed);
  const updates: Uint8Array[] = [];
  d.on("update", (u: Uint8Array) => updates.push(u));
  d.transact(() => t.insert(at, insert));
  return updates[0]!;
}

describe("append → load 往返", () => {
  it("空房间返回 null", () => {
    expect(loadMergedLocalState(ROOM)).toBeNull();
    expect(hasLocalUpdates(ROOM)).toBe(false);
  });

  it("单条 update 灌入新 doc 后文本一致", () => {
    appendLocalUpdate(ROOM, textUpdate("", "你好，离线世界"), { clientId: 1, ts: 1000 });
    expect(hasLocalUpdates(ROOM)).toBe(true);

    const merged = loadMergedLocalState(ROOM);
    expect(merged).toBeInstanceOf(Uint8Array);
    const dst = new Y.Doc();
    Y.applyUpdate(dst, merged!);
    expect(dst.getText("body").toString()).toBe("你好，离线世界");
  });

  it("多次增量 update 合并后按 CRDT 还原最终文本（不是整篇二选一）", () => {
    // 三次编辑：初始 → 中间插入 → 末尾追加。起点需带相同前缀，逐条追加到同一累积键。
    const a = textUpdate("", "AC");
    appendLocalUpdate(ROOM, a, { clientId: 1, ts: 1 });

    const d2 = new Y.Doc();
    Y.applyUpdate(d2, loadMergedLocalState(ROOM)!);
    const u2: Uint8Array[] = [];
    d2.on("update", (u: Uint8Array) => u2.push(u));
    d2.getText("body").insert(1, "B");
    appendLocalUpdate(ROOM, u2[0]!, { clientId: 1, ts: 2 });

    const d3 = new Y.Doc();
    Y.applyUpdate(d3, loadMergedLocalState(ROOM)!);
    const u3: Uint8Array[] = [];
    d3.on("update", (u: Uint8Array) => u3.push(u));
    d3.getText("body").insert(3, "D");
    appendLocalUpdate(ROOM, u3[0]!, { clientId: 1, ts: 3 });

    const dst = new Y.Doc();
    Y.applyUpdate(dst, loadMergedLocalState(ROOM)!);
    expect(dst.getText("body").toString()).toBe("ABCD");
  });
});

describe("防二次回存的根因：transaction.local", () => {
  it("applyUpdate 灌入产生的事务 local=false（累积层据此不回存）；本地 transact 为 true", () => {
    appendLocalUpdate(ROOM, textUpdate("", "本地编辑"), { clientId: 7, ts: 1 });

    const dst = new Y.Doc();
    const seen: Array<{ local: boolean }> = [];
    dst.on("update", (_u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
      seen.push({ local: tr.local });
    });

    // ① 灌入（Y.applyUpdate）：必须 local=false，provider 的 onLocalUpdate 会跳过，不回存。
    Y.applyUpdate(dst, loadMergedLocalState(ROOM)!, "gx-y-local-replay");
    // ② 编辑器式本地事务：local=true，会被累积。
    dst.transact(() => dst.getText("body").insert(4, "!"));

    expect(seen[0]!.local).toBe(false);
    expect(seen[1]!.local).toBe(true);
  });
});

describe("确认合并后清除", () => {
  it("clearLocalUpdates 幂等，清除后 load/has 都为空", () => {
    appendLocalUpdate(ROOM, textUpdate("", "x"), { clientId: 1, ts: 1 });
    expect(hasLocalUpdates(ROOM)).toBe(true);
    clearLocalUpdates(ROOM);
    expect(hasLocalUpdates(ROOM)).toBe(false);
    expect(loadMergedLocalState(ROOM)).toBeNull();
    expect(() => clearLocalUpdates(ROOM)).not.toThrow(); // 再清一次不抛
  });
});

describe("坏数据自愈", () => {
  it("非法 JSON：删键、返回 null、不抛", () => {
    storage.setRaw(KEY, "{不是 json");
    expect(() => loadMergedLocalState(ROOM)).not.toThrow();
    expect(loadMergedLocalState(ROOM)).toBeNull();
    expect(storage.getRaw(KEY)).toBeUndefined(); // 已自愈删键
  });

  it("形状不对（缺 u / 版本不符）：删键返回 null", () => {
    storage.setRaw(KEY, JSON.stringify({ v: 99, u: [] }));
    expect(loadMergedLocalState(ROOM)).toBeNull();
    expect(storage.getRaw(KEY)).toBeUndefined();
  });

  it("某条增量 base64 合法但 update 字节损坏：mergeUpdates 失败 → 丢键返回 null", () => {
    appendLocalUpdate(ROOM, textUpdate("", "good"), { clientId: 1, ts: 1 });
    const raw = JSON.parse(storage.getRaw(KEY)!);
    raw.u.push({ b: btoa(String.fromCharCode(0, 1, 2, 3, 250, 251)), c: 1, t: 2, q: 1 });
    storage.setRaw(KEY, JSON.stringify(raw));
    expect(() => loadMergedLocalState(ROOM)).not.toThrow();
    expect(loadMergedLocalState(ROOM)).toBeNull();
    expect(storage.getRaw(KEY)).toBeUndefined();
  });

  it("append 遇到历史坏数据不抛：丢弃坏段、保住当前增量", () => {
    storage.setRaw(KEY, "@@bad@@");
    expect(() => appendLocalUpdate(ROOM, textUpdate("", "救回"), { clientId: 2, ts: 9 })).not.toThrow();
    const dst = new Y.Doc();
    Y.applyUpdate(dst, loadMergedLocalState(ROOM)!);
    expect(dst.getText("body").toString()).toBe("救回");
  });
});

describe("超阈值压缩为快照", () => {
  it("累积超过 2MB 软上限后就地压成单快照（s 有值、u 清空），内容仍可完整还原", () => {
    const CHUNK = 100_000; // 每段 10 万字符，累计必在第 21 段前越过 2MB
    const work = new Y.Doc();
    let compacted = false;
    let total = "";
    for (let round = 0; round < 40; round += 1) {
      const piece = "字".repeat(CHUNK);
      const ups: Uint8Array[] = [];
      const handler = (u: Uint8Array): void => {
        ups.push(u);
      };
      work.on("update", handler);
      work.transact(() => work.getText("body").insert(total.length, piece));
      work.off("update", handler);
      appendLocalUpdate(ROOM, ups[0]!, { clientId: work.clientID, ts: round });
      total += piece;
      const shape = JSON.parse(storage.getRaw(KEY)!);
      if (shape.s !== undefined) {
        compacted = true;
        expect(Array.isArray(shape.u)).toBe(true);
        expect(shape.u.length).toBe(0);
        break;
      }
    }
    expect(compacted).toBe(true);
    const dst = new Y.Doc();
    Y.applyUpdate(dst, loadMergedLocalState(ROOM)!);
    const restored = dst.getText("body").toString();
    expect(restored.length).toBe(total.length);
    expect(restored).toBe(total);
  }, 30_000);
});

describe("无 localStorage（SSR / 单测）安全降级", () => {
  beforeEach(() => {
    // @ts-expect-error 模拟无 localStorage
    delete globalThis.localStorage;
  });

  it("append/load/clear/has 全部 no-op 或 null，不抛", () => {
    expect(() => appendLocalUpdate(ROOM, textUpdate("", "x"), { clientId: 1, ts: 1 })).not.toThrow();
    expect(loadMergedLocalState(ROOM)).toBeNull();
    expect(hasLocalUpdates(ROOM)).toBe(false);
    expect(() => clearLocalUpdates(ROOM)).not.toThrow();
  });
});

describe("fail-closed 门控 yOfflineGate", () => {
  it("只认 1/true；undefined/空/0/其它一律关", () => {
    expect(isYOfflineFlagEnabled("1")).toBe(true);
    expect(isYOfflineFlagEnabled("true")).toBe(true);
    expect(isYOfflineFlagEnabled(" TRUE ")).toBe(true);
    for (const v of [undefined, null, "", "0", "yes", "on", "11"]) {
      expect(isYOfflineFlagEnabled(v)).toBe(false);
    }
  });

  it("构建默认（无注入）在 node 下恒关", () => {
    expect(yOfflineEnabled()).toBe(false);
  });

  it("isCollabBindingStatus：门关时仅 connected 绑定（与旧 status===connected 等价）", () => {
    expect(isCollabBindingStatus("connected", false)).toBe(true);
    for (const s of ["connecting", "reconnecting", "offline", "denied", "idle"] as const) {
      expect(isCollabBindingStatus(s, false)).toBe(false);
    }
  });

  it("isCollabBindingStatus：门开时 connected/connecting/reconnecting/offline 都绑定，denied/idle 不绑", () => {
    for (const s of ["connected", "connecting", "reconnecting", "offline"] as const) {
      expect(isCollabBindingStatus(s, true)).toBe(true);
    }
    expect(isCollabBindingStatus("denied", true)).toBe(false);
    expect(isCollabBindingStatus("idle", true)).toBe(false);
  });
});

// 防止常量被误改到不合理量级（压缩策略的契约）。
describe("存储契约", () => {
  it("软上限为 2MB", () => {
    expect(MAX_STORED_KEY_CHARS).toBe(2 * 1024 * 1024);
  });
});

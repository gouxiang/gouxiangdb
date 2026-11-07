// apps/web/src/features/kb/__tests__/useDocPersistence.test.tsx
// 修复 A「持久化在途串行化」契约测试。
//
// 环境限制（如实记录）：本仓 vitest 跑 node 且无 jsdom / @testing-library，useEffect 在 SSR
// 下不执行。本套件要在「异步 drain 落库之后」读取最新 state（conflict/status），单次
// renderToString 的快照不会随 setState 更新，故沿用仓内 login-remote-slot.test.tsx 已验证的
// React.__SECRET_INTERNALS ReactCurrentDispatcher seam：真实执行 useDocPersistence 的函数体与
// 生产闭包（真 useState/useRef/useCallback，useEffect 按 SSR 语义跳过），把 hook 状态存进外部
// hookSlots，从而能在 await 之后再次 renderOnce 读到最新 state。四个外部依赖全部 vi.mock，
// mentions 保留真实纯函数（embed 防丢正依赖它），不新增任何依赖。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";

// ── 模块 mock（hoisted，先于被提升的 import 求值）──────────────────────────────
const h = vi.hoisted(() => ({
  saveContent: vi.fn(),
  doc: vi.fn(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  ensureQueryData: vi.fn(),
  getQueryData: vi.fn(),
  toast: vi.fn(),
  saveDraft: vi.fn(),
  loadDraft: vi.fn(),
  clearDraft: vi.fn(),
  clearDraftUnlessSourceUnmerged: vi.fn(),
  hasRecoverableDraft: vi.fn((): Draft | null => null),
  baseFor: vi.fn((p: string) => p),
  headers: vi.fn(() => ({})),
  fetch: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    setQueryData: h.setQueryData,
    invalidateQueries: h.invalidateQueries,
    ensureQueryData: h.ensureQueryData,
    getQueryData: h.getQueryData,
  }),
}));
vi.mock("../../../components/ui", () => ({ toast: (...a: unknown[]) => h.toast(...a) }));
vi.mock("../../../api/client", () => ({
  KbApi: { saveContent: h.saveContent, doc: h.doc },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API ${status}`);
    }
  },
}));
vi.mock("../../../node/datasource", () => ({
  dataSourceResolver: { baseFor: h.baseFor, headers: h.headers },
}));
vi.mock("../draft", () => ({
  saveDraft: h.saveDraft,
  loadDraft: h.loadDraft,
  clearDraft: h.clearDraft,
  clearDraftUnlessSourceUnmerged: h.clearDraftUnlessSourceUnmerged,
  hasRecoverableDraft: h.hasRecoverableDraft,
}));

import { useDocPersistence, missingEmbeds } from "../useDocPersistence";
import { ApiError } from "../../../api/client";
import type { Draft } from "../draft";

type Persist = ReturnType<typeof useDocPersistence>;
type SaveCall = { content: string; baseVersion: number | undefined };

const SERVER_BASE = "BASE-TEXT";
const saveCalls = (): SaveCall[] => h.saveContent.mock.calls.map((c) => c[1] as SaveCall);
const baseVersions = () => saveCalls().map((c) => c.baseVersion);

// 生产 ApiError.body 类型未声明 409 专属的 currentVersion（生产侧读取时同样做 cast），
// 测试构造冲突错误时按 unknown 中转到真实构造参数类型。
const conflictError = (currentVersion: number) =>
  new ApiError(
    409,
    { currentVersion } as unknown as ConstructorParameters<typeof ApiError>[1],
  );

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushMicro = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── 迷你函数式渲染器：真实 dispatcher，状态进 hookSlots，可跨 await 重渲染读最新 state ──
const INTERNALS = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown };
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

let hookSlots: unknown[] = [];
let hookIdx = 0;
// 依赖感知的 effect 槽：仅 renderWith（显式开启）时收集并在每次渲染后按 deps 变化执行，
// 忠实复现 React 的「首挂载执行 / 依赖变更先 cleanup 再重跑 / 未变跳过」。effect 按 hook 位置
// （hookIdx）索引而非 deps 数组身份——每次渲染都传入新 deps 数组，React 实按位置比对值。
// 默认 renderOnce 仍不跑 effect（SSR noop），既有用例的挂载语义逐字不变。
type RegEffect = { deps: unknown[]; cleanup?: void | (() => void) };
let effectSlots: (RegEffect | undefined)[] = [];
let runEffects = false;
function dispatcher() {
  return {
    useState(init: unknown) {
      const i = hookIdx++;
      if (!(i in hookSlots)) hookSlots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const setState = (v: unknown) => {
        hookSlots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hookSlots[i]) : v;
      };
      return [hookSlots[i], setState];
    },
    useRef(init: unknown) {
      const i = hookIdx++;
      if (!(i in hookSlots)) hookSlots[i] = { current: init };
      return hookSlots[i];
    },
    useCallback: (fn: unknown) => fn,
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const pos = hookIdx++; // 与 useState/useRef 共用稳定的 hook 位置序列
      if (!runEffects || !deps) return undefined; // SSR seam：默认渲染不执行任何 effect
      const existing = effectSlots[pos];
      if (existing) {
        const changed = deps.some((d, k) => !Object.is(d, existing.deps[k]));
        if (changed) {
          existing.cleanup?.();
          existing.deps = deps;
          existing.cleanup = fn();
        }
      } else {
        effectSlots[pos] = { deps, cleanup: fn() };
      }
      return undefined;
    },
    useMemo: (fn: () => unknown) => fn(),
    useDebugValue: () => undefined,
  };
}

let holder: Persist | null = null;
// 探针入参（默认值与引入第 7 参之前的既有 5 参调用逐字一致，保证既有用例零回归）。
type ProbeArgs = {
  docId?: string;
  serverContent?: string;
  canEdit?: boolean;
  serverVersion?: number;
  collabActive?: boolean;
  yOwned?: boolean;
  sourceMode?: boolean;
};
function Probe(args: ProbeArgs = {}) {
  const {
    docId = "d1",
    serverContent = SERVER_BASE,
    canEdit = true,
    serverVersion = 3,
    collabActive = false,
    yOwned = false,
    sourceMode = false,
  } = args;
  holder = useDocPersistence(
    docId,
    "k1",
    serverContent,
    canEdit,
    serverVersion,
    collabActive,
    yOwned,
    sourceMode,
  );
  return null;
}
/** SSR 渲染：真实跑 hook 函数体与闭包，但 useEffect 按生产 SSR 语义跳过（既有 10 用例的挂载方式）。 */
function renderOnce() {
  hookIdx = 0;
  const prev = INTERNALS.ReactCurrentDispatcher.current;
  INTERNALS.ReactCurrentDispatcher.current = dispatcher();
  try {
    Probe();
  } finally {
    INTERNALS.ReactCurrentDispatcher.current = prev;
  }
}
const api = (): Persist => {
  if (!holder) throw new Error("未挂载");
  return holder;
};
/** 重渲染并读最新 state（refs 跨渲染持久，state 取最新 slot）。 */
const refresh = () => {
  renderOnce();
  return api();
};
/**
 * 开启依赖感知 effect 的渲染：用于验证加载/接管态切换 effect（默认 SSR seam 下它们是 noop）。
 * 首次调用按「挂载」跑全部 effect；之后按 deps 变化决定重跑，模拟同一组件实例的重渲染。
 * effect 在 hook 函数返回后才同步触发、其 setState 写入 slot 已晚于本次 holder 快照，故再做一遍
 * noop readback（不跑 effect）让 holder 读到被 effect 更新后的 state，忠实反映真实提交后的结果。
 */
function renderWith(args: ProbeArgs = {}) {
  const runPass = (withEffects: boolean) => {
    hookIdx = 0;
    runEffects = withEffects;
    const prev = INTERNALS.ReactCurrentDispatcher.current;
    INTERNALS.ReactCurrentDispatcher.current = dispatcher();
    try {
      Probe(args);
    } finally {
      INTERNALS.ReactCurrentDispatcher.current = prev;
      runEffects = false;
    }
  };
  runPass(true); // 挂载/重渲染：跑依赖感知 effect
  runPass(false); // readback：仅重读被 effect 更新后的 state slot，不再触发 effect
  return api();
}
/** 只读快照：不跑 effect 重渲染一次，用于回调内 setState（如 markDirty→setStatus）后读最新值。 */
function snapshot(args: ProbeArgs = {}) {
  hookIdx = 0;
  const prev = INTERNALS.ReactCurrentDispatcher.current;
  INTERNALS.ReactCurrentDispatcher.current = dispatcher(); // runEffects 默认 false → effect noop
  try {
    Probe(args);
  } finally {
    INTERNALS.ReactCurrentDispatcher.current = prev;
  }
  return api();
}
/** 重置 effect 槽（配合 beforeEach 的 hookSlots 清空，模拟全新挂载）。 */
function resetEffects() {
  effectSlots = [];
}

beforeEach(() => {
  hookSlots = [];
  hookIdx = 0;
  resetEffects();
  vi.clearAllMocks();
  vi.useFakeTimers();
  renderOnce();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("在途串行化：同 docId 任意时刻最多一个 PUT", () => {
  it("防抖期多次 markDirty 塌缩；在途新编辑并入串行链，baseVersion 严格递增、绝不重复", async () => {
    const d1 = deferred<{ contentVersion: number }>();
    let n = 0;
    h.saveContent.mockImplementation(() => {
      n += 1;
      // 第一次调用交给受控 deferred 制造「在途」窗口；其后的调用立即落库
      return n === 1 ? d1.promise : Promise.resolve({ contentVersion: 5 });
    });

    api().markDirty("v1");
    api().markDirty("v2"); // 1200ms 内连续改动：重置防抖，pending 塌缩为 v2
    expect(h.saveContent).not.toHaveBeenCalled();

    await vi.runAllTimersAsync(); // 触发首个 PUT（baseVersion=3, content=v2），进入在途
    expect(baseVersions()).toEqual([3]);

    api().markDirty("v3"); // 在途期间涌入：只覆盖 pending，不发新请求
    api().markDirty("v4");
    expect(h.saveContent).toHaveBeenCalledTimes(1);

    d1.resolve({ contentVersion: 4 });
    await flushMicro(); // 第一轮回来 → while 第二轮带最新 baseVersion=4 发 v4

    expect(h.saveContent).toHaveBeenCalledTimes(2);
    expect(baseVersions()).toEqual([3, 4]); // 无重复 baseVersion（旧 bug 会是 [3,3]）
    expect(saveCalls().map((c) => c.content)).toEqual(["v2", "v4"]); // v1/v3 被塌缩
  });

  it("saveNow 与在途 PUT 不并行：在途时调用并入该链，链排空仅弹一次成功 toast", async () => {
    const d1 = deferred<{ contentVersion: number }>();
    h.saveContent.mockImplementation(() => d1.promise);

    api().markDirty("a");
    await vi.runAllTimersAsync(); // 首个 PUT 在途
    expect(h.saveContent).toHaveBeenCalledTimes(1);

    await api().saveNow(); // 在途：drain 入口直接 return，不发第二个请求
    expect(h.saveContent).toHaveBeenCalledTimes(1);
    expect(h.toast).not.toHaveBeenCalled(); // 链未排空，暂不提示

    d1.resolve({ contentVersion: 4 });
    await flushMicro();

    expect(h.saveContent).toHaveBeenCalledTimes(1);
    expect(baseVersions()).toEqual([3]);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith("已保存到云端", "success");
  });
});

describe("409 冲突：置位并暂停 drain，不自动重发刷弹窗", () => {
  it("撞 409 后仅发一次 PUT、置冲突态、invalidate 且草稿兜底；冲突期 markDirty 不续发", async () => {
    const d1 = deferred<never>();
    h.saveContent.mockImplementation(() => d1.promise);

    api().markDirty("x");
    await vi.runAllTimersAsync();
    api().markDirty("y"); // 在途再编辑
    expect(h.saveContent).toHaveBeenCalledTimes(1);

    d1.reject(conflictError(7));
    await flushMicro();
    await vi.runAllTimersAsync(); // 挂起的防抖 timer 触发也必须被冲突态拦住

    expect(h.saveContent).toHaveBeenCalledTimes(1); // 没有自动重发撞第二次 409
    expect(refresh().conflict).toEqual({ currentVersion: 7 });
    expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["kb", "doc", "d1"] });
    expect(h.saveDraft).toHaveBeenCalled(); // 本地草稿兜底，内容不丢

    api().markDirty("z"); // 冲突待裁决：只更新 pending/草稿，不发请求
    await vi.runAllTimersAsync();
    expect(h.saveContent).toHaveBeenCalledTimes(1);
  });
});

describe("keepMineVersion：覆盖前 embed 防丢 + 强制覆盖的基线抬升", () => {
  /** 先制造一个 currentVersion=7 的冲突态。 */
  async function seedConflict() {
    const d1 = deferred<never>();
    h.saveContent.mockImplementation(() => d1.promise);
    api().markDirty("changed");
    await vi.runAllTimersAsync();
    d1.reject(conflictError(7));
    await flushMicro();
    expect(refresh().conflict).toEqual({ currentVersion: 7 });
  }

  it("服务端有本地缺失的画布/表格引用 → 拦截：不发 PUT、不清冲突、toast 报缺失数量", async () => {
    await seedConflict();
    const serverSrc =
      "前言\n```canvas-embed\ncanvasA\n```\n中段\n```table-embed\ntbl1\nview9\n```\n尾";
    h.ensureQueryData.mockResolvedValue({ id: "d1", kind: "doc", title: "t", content: serverSrc });

    const ok = await api().keepMineVersion();

    expect(ok).toBe(false);
    expect(h.ensureQueryData).toHaveBeenCalledTimes(1);
    expect(h.ensureQueryData.mock.calls[0]![0].queryKey).toEqual(["kb", "doc", "d1"]); // 精确 3 键
    expect(h.saveContent).toHaveBeenCalledTimes(1); // 仅 seedConflict 那一次，拦截后零新增
    expect(refresh().conflict).toEqual({ currentVersion: 7 }); // 冲突态保留
    const msg = h.toast.mock.calls.find((c) => String(c[0]).includes("缺少"))?.[0];
    expect(String(msg)).toContain("缺少 2 个");
  });

  it("无引用丢失且内容与 lastSaved 相同 → 靠 force 仍发出 PUT，baseVersion 抬到 currentVersion", async () => {
    await seedConflict();
    // 冲突期把 pending 改回与 lastSaved 字面相同（旧短路会让这次 PUT 发不出去）
    api().markDirty(SERVER_BASE);
    h.ensureQueryData.mockResolvedValue({ id: "d1", kind: "doc", title: "t", content: "服务端纯文本无引用" });
    h.saveContent.mockImplementation(() => Promise.resolve({ contentVersion: 8 }));

    const ok = await api().keepMineVersion();
    await flushMicro();

    expect(ok).toBe(true);
    const calls = saveCalls();
    expect(calls).toHaveLength(2); // seedConflict 1 次 + 强制覆盖 1 次
    expect(calls[calls.length - 1]).toMatchObject({ content: SERVER_BASE, baseVersion: 7 });
    expect(refresh().conflict).toBeNull();
  });

  it("ensureQueryData 取服务端正文失败 → 不盲目覆盖，保留冲突态", async () => {
    await seedConflict();
    h.ensureQueryData.mockRejectedValue(new Error("network"));

    const ok = await api().keepMineVersion();

    expect(ok).toBe(false);
    expect(h.saveContent).toHaveBeenCalledTimes(1); // 无新增 PUT
    expect(refresh().conflict).toEqual({ currentVersion: 7 });
  });
});

describe("flush（卸载兜底）：不在途自撞，且回写缓存带 contentVersion", () => {
  it("drain 在途时 flush 直接返回，不发第二个 keepalive PUT", async () => {
    vi.stubGlobal("fetch", h.fetch);
    const d1 = deferred<never>();
    h.saveContent.mockImplementation(() => d1.promise);

    api().markDirty("a");
    await vi.runAllTimersAsync(); // PUT 在途
    api().flush();

    expect(h.fetch).not.toHaveBeenCalled();
    d1.reject(conflictError(7)); // 收尾，避免悬挂
    await flushMicro();
  });

  it("无在途、有 pending 时发 keepalive PUT，成功后 syncDocCache 带上第三参 contentVersion", async () => {
    vi.stubGlobal("fetch", h.fetch);
    let cached: { content: string; contentVersion?: number } | undefined;
    h.setQueryData.mockImplementation((_k: unknown, updater: (old: unknown) => unknown) => {
      cached = updater({ id: "d1", kind: "doc", title: "t", content: "old", contentVersion: 3 }) as never;
    });
    h.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ contentVersion: 9 }) });

    api().markDirty("flushme"); // 不推进防抖 timer，保留 pending
    api().flush();

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/kb/docs/d1/content");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toMatchObject({ content: "flushme", baseVersion: 3 });
    await flushMicro();
    expect(cached).toMatchObject({ content: "flushme", contentVersion: 9 }); // 第三参已透传
  });
});

describe("missingEmbeds 纯函数", () => {
  const canvas = (id: string) => "```canvas-embed\n" + id + "\n```";
  const table = (tid: string, vid?: string) => "```table-embed\n" + tid + "\n" + (vid ?? "") + "\n```";

  it("只报「服务端有、本地无」；本地独有不算缺失", () => {
    const server = canvas("a") + table("t1", "v1");
    const local = canvas("a") + canvas("local-only");
    const r = missingEmbeds(server, local);
    expect(r.canvas).toEqual([]);
    expect(r.tables).toEqual([{ tableId: "t1", viewId: "v1" }]);
  });

  it("同表不同视图按不同键判定，缺画布与缺表格分别归集", () => {
    const r = missingEmbeds(canvas("c1") + table("t1", "v1"), table("t1", "v2"));
    expect(r.canvas).toEqual(["c1"]);
    expect(r.tables).toEqual([{ tableId: "t1", viewId: "v1" }]);
  });
});

// renderWith 会真实跑 effect（含卸载监听 effect，其体内访问 window）；node 环境无 window，stub 之。
describe("yOwned（Y 通道接管）：REST 全面让位，草稿恢复条跟随接管态", () => {
  const win = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  beforeEach(() => {
    vi.stubGlobal("window", win);
  });
  const D: Draft = { content: "draft-text", baseContent: SERVER_BASE, savedAt: 1 };

  describe("markDirty / flush / saveNow：接管态不发任何整篇 PUT", () => {
    it("yOwned=true：markDirty 只留草稿不排防抖 PUT、状态 synced；flush 不发 fetch；saveNow 仅 toast", async () => {
      const a = renderWith({ yOwned: true });

      a.markDirty("edited-src"); // 模拟源码态（无 Y 绑定窗口）编辑
      expect(h.saveContent).not.toHaveBeenCalled(); // 不发 REST PUT
      expect(h.saveDraft).toHaveBeenCalledTimes(1); // 源码态崩溃兜底草稿保留
      expect(h.saveDraft).toHaveBeenCalledWith("d1", {
        content: "edited-src",
        baseContent: SERVER_BASE,
      });
      expect(snapshot({ yOwned: true }).status).toBe("synced");

      await vi.runAllTimersAsync(); // 没有任何防抖 PUT 被排期
      expect(h.saveContent).not.toHaveBeenCalled();

      a.flush(); // 卸载/切路由兜底也不让位出 keepalive PUT
      expect(h.fetch).not.toHaveBeenCalled();

      await a.saveNow(); // 手动保存只给协同反馈，绝不发 PUT（含掉线窗口，根治假 409）
      expect(h.saveContent).not.toHaveBeenCalled();
      expect(h.toast).toHaveBeenCalledWith("已在协同中实时同步，无需手动保存", "success");
    });
  });

  describe("恢复条显隐跟随 Y 接管态（堵「doc 缓存先到、协同后连」重进时序缺口）", () => {
    it("yOwned=true 挂载：加载逻辑短路，不消费草稿提示，recovered 恒为 null", () => {
      h.hasRecoverableDraft.mockReturnValue(D);
      const a = renderWith({ yOwned: true });
      expect(h.hasRecoverableDraft).not.toHaveBeenCalled(); // 加载 effect 走 yOwned 短路，根本不读草稿
      expect(a.recovered).toBeNull();
    });

    it("yOwned=false 挂载（默认路径不回归）：hasRecoverableDraft 的结果成为 recovered", () => {
      h.hasRecoverableDraft.mockReturnValue(D);
      const a = renderWith({ yOwned: false });
      expect(h.hasRecoverableDraft).toHaveBeenCalledWith("d1", SERVER_BASE);
      expect(a.recovered).toEqual(D);
    });

    it("false→true 上升沿：首帧据草稿弹出的恢复条在 WS 建连 Y 接管后被收回", () => {
      h.hasRecoverableDraft.mockReturnValue(D);
      // 重进页面：React Query 缓存命中 doc 首帧即到，而协同 status 仍 idle（yOwned=false）
      const first = renderWith({ yOwned: false });
      expect(first.recovered).toEqual(D); // 缺口现场：恢复条已弹
      // WS 建连 status→connecting/connected，yOwned 翻转：切换 effect 必须收回恢复条
      const after = renderWith({ yOwned: true });
      expect(after.recovered).toBeNull();
    });

    it("true→false 下降沿（协同 denied、真源切回 REST）：正文已到位则重算，合法草稿恢复条仍可达", () => {
      h.hasRecoverableDraft.mockReturnValue(D);
      renderWith({ yOwned: true }); // 先进入接管
      const back = renderWith({ yOwned: false }); // 退回 REST 真源
      expect(h.hasRecoverableDraft).toHaveBeenCalledWith("d1", SERVER_BASE);
      expect(back.recovered).toEqual(D);
    });
  });
});

// ── 热修对抗审查 P1-1 / P1-2 / P2-1 / P2-2 回归 ─────────────────────────────────
type UnloadEv = { preventDefault: ReturnType<typeof vi.fn>; returnValue: unknown };
describe("热修：yOwned 四项（drain 闸门 / source 安全网 / synced 状态 / beforeunload）", () => {
  // 捕获卸载 effect 注册的 beforeunload handler（P2-2 手动触发）。
  const handlers: Record<string, (e: UnloadEv) => void> = {};
  const win = {
    addEventListener: vi.fn((ev: string, fn: (e: UnloadEv) => void) => {
      handlers[ev] = fn;
    }),
    removeEventListener: vi.fn(),
  };
  const SOURCE_DRAFT: Draft = {
    content: "src-unmerged",
    baseContent: SERVER_BASE,
    savedAt: 9,
    sourceUnmerged: true,
  };
  const PLAIN_DRAFT: Draft = { content: "plain-draft", baseContent: SERVER_BASE, savedAt: 8 };

  beforeEach(() => {
    vi.stubGlobal("window", win);
    // clearAllMocks 不清实现，这里显式重建每条用例的草稿 mock 基线，杜绝跨用例污染。
    h.loadDraft.mockReset();
    h.loadDraft.mockReturnValue(null);
    h.hasRecoverableDraft.mockReset();
    h.hasRecoverableDraft.mockReturnValue(null);
    h.clearDraftUnlessSourceUnmerged.mockReset();
    h.clearDraftUnlessSourceUnmerged.mockReturnValue(true);
  });

  describe("P1-1 drain 闸门：yOwned 翻转后绝不续发整篇 PUT", () => {
    it("非协同起手在途 PUT 期间翻 true 并再 markDirty：PUT1 回来后 saveContent 仍只 1 次", async () => {
      const d1 = deferred<{ contentVersion: number }>();
      let n = 0;
      h.saveContent.mockImplementation(() => {
        n += 1;
        return n === 1 ? d1.promise : Promise.resolve({ contentVersion: 6 });
      });
      const a0 = renderWith({ yOwned: false });
      a0.markDirty("v1");
      await vi.runAllTimersAsync(); // 防抖触发 PUT1，进入在途
      expect(h.saveContent).toHaveBeenCalledTimes(1);

      // 在途期间 WS 建连、Y 接管翻转（yOwned true），用户继续编辑：只写草稿不发 PUT
      const a1 = renderWith({ yOwned: true });
      a1.markDirty("v2-source");
      expect(h.saveContent).toHaveBeenCalledTimes(1);

      // PUT1 回来：while 续体与 finally 补轮都被 !yOwnedRef 拦住，不得发第二个 PUT
      d1.resolve({ contentVersion: 5 });
      await flushMicro();
      await vi.runAllTimersAsync();
      expect(h.saveContent).toHaveBeenCalledTimes(1);
    });

    it("非协同（yOwned 恒 false）串行链不回归：在途新编辑仍续发第二个 PUT", async () => {
      const d1 = deferred<{ contentVersion: number }>();
      let n = 0;
      h.saveContent.mockImplementation(() => {
        n += 1;
        return n === 1 ? d1.promise : Promise.resolve({ contentVersion: 6 });
      });
      const a = renderWith({ yOwned: false });
      a.markDirty("v1");
      await vi.runAllTimersAsync();
      expect(h.saveContent).toHaveBeenCalledTimes(1);
      a.markDirty("v2"); // 在途新编辑，仍是非协同 → 闸门恒真，应续发
      d1.resolve({ contentVersion: 5 });
      await flushMicro();
      expect(h.saveContent).toHaveBeenCalledTimes(2);
    });
  });

  describe("P2-1 协同态不被重连 refetch 打成「已保存到云端」", () => {
    it("yOwned=true 加载后 status 为 synced 而非 saved", () => {
      expect(renderWith({ yOwned: true }).status).toBe("synced");
    });
    it("yOwned=false 加载后 status 维持 saved（默认路径不回归）", () => {
      expect(renderWith({ yOwned: false }).status).toBe("saved");
    });
  });

  describe("P2-2 beforeunload 离开确认", () => {
    it("yOwned=true markDirty 后触发 beforeunload：不设 preventDefault/returnValue", () => {
      const a = renderWith({ yOwned: true });
      a.markDirty("edited"); // pending 被置位，但接管态不应弹离开框
      const e: UnloadEv = { preventDefault: vi.fn(), returnValue: undefined };
      handlers["beforeunload"](e);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(e.returnValue).toBeUndefined();
    });
    it("非协同 yOwned=false 有未保存 pending 时 beforeunload 仍拦截（默认不回归）", () => {
      const a = renderWith({ yOwned: false });
      a.markDirty("unsaved-change"); // pending ≠ lastSaved
      const e: UnloadEv = { preventDefault: vi.fn(), returnValue: undefined };
      handlers["beforeunload"](e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
      expect(e.returnValue).toBe("");
    });
  });

  describe("P1-2 sourceUnmerged 源码安全网（不丢、可恢复、不被误清）", () => {
    it("sourceMode=true 的 yOwned markDirty：saveDraft 带 sourceUnmerged:true", () => {
      const a = renderWith({ yOwned: true, sourceMode: true });
      a.markDirty("src-edit");
      expect(h.saveDraft).toHaveBeenCalledWith("d1", {
        content: "src-edit",
        baseContent: SERVER_BASE,
        sourceUnmerged: true,
      });
    });
    it("sourceMode=false 的 yOwned markDirty：saveDraft 不带 sourceUnmerged（默认不回归）", () => {
      const a = renderWith({ yOwned: true, sourceMode: false });
      a.markDirty("wy-edit");
      expect(h.saveDraft).toHaveBeenCalledWith("d1", {
        content: "wy-edit",
        baseContent: SERVER_BASE,
      });
    });
    it("yOwned 挂载：loadDraft 取到 sourceUnmerged 草稿 → recovered 保留恢复入口，且不走 hasRecoverableDraft", () => {
      h.loadDraft.mockReturnValue(SOURCE_DRAFT);
      const a = renderWith({ yOwned: true });
      expect(a.recovered).toEqual(SOURCE_DRAFT);
      expect(h.hasRecoverableDraft).not.toHaveBeenCalled();
    });
    it("yOwned 挂载：loadDraft 仅取到普通草稿 → recovered=null（Bug A 普通残留不弹条）", () => {
      h.loadDraft.mockReturnValue(PLAIN_DRAFT);
      expect(renderWith({ yOwned: true }).recovered).toBeNull();
    });
    it("false→true 上升沿：sourceUnmerged 草稿不被收回（恢复入口保留）", () => {
      h.hasRecoverableDraft.mockReturnValue(PLAIN_DRAFT); // 非接管首帧据普通草稿弹条
      h.loadDraft.mockReturnValue(SOURCE_DRAFT); // 接管后本地实为 source 未合并草稿
      expect(renderWith({ yOwned: false }).recovered).toEqual(PLAIN_DRAFT);
      expect(renderWith({ yOwned: true }).recovered).toEqual(SOURCE_DRAFT);
    });
    it("false→true 上升沿：仅普通草稿（无 sourceUnmerged）→ 仍被收回为 null", () => {
      h.hasRecoverableDraft.mockReturnValue(PLAIN_DRAFT);
      h.loadDraft.mockReturnValue(PLAIN_DRAFT);
      renderWith({ yOwned: false });
      expect(renderWith({ yOwned: true }).recovered).toBeNull();
    });
    it("在途 PUT 成功路径走条件清理：clearDraftUnlessSourceUnmerged 以 docId 被调用", async () => {
      h.saveContent.mockResolvedValue({ contentVersion: 5 });
      const a = renderWith({ yOwned: false });
      a.markDirty("v1");
      await vi.runAllTimersAsync();
      await flushMicro();
      expect(h.clearDraftUnlessSourceUnmerged).toHaveBeenCalledWith("d1");
    });
  });
});

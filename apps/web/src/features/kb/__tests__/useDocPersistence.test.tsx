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
  hasRecoverableDraft: vi.fn(() => null),
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
  hasRecoverableDraft: h.hasRecoverableDraft,
}));

import { useDocPersistence, missingEmbeds } from "../useDocPersistence";
import { ApiError } from "../../../api/client";

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
    useEffect: () => undefined,
    useMemo: (fn: () => unknown) => fn(),
    useDebugValue: () => undefined,
  };
}

let holder: Persist | null = null;
function Probe() {
  holder = useDocPersistence("d1", "k1", SERVER_BASE, true, 3);
  return null;
}
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

beforeEach(() => {
  hookSlots = [];
  hookIdx = 0;
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

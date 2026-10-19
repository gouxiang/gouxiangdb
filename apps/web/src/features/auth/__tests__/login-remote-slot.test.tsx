// 登录/改密「按活动节点分槽写入」集成测试。
//
// 仓库 web 包未安装 jsdom / @testing-library（vitest 仅声明可选 peer；实测在本仓切到
// jsdom 测试环境会直接报 ERR_MODULE_NOT_FOUND），且本改造禁止新增依赖。
// 故沿用仓库既有 React.__SECRET_INTERNALS ReactCurrentDispatcher seam（与
// activeSession.test.ts 同款、已在仓内使用）：真实执行 LoginPage / ForceChangePassword
// 的函数体与生产提交闭包——真 useState、真 zustand（useAuthStore）、真 useNavigate 捕获、
// 真 Auth.* mock、真 launcher store + dataSourceResolver + 分键存储；再从组件返回的
// React 元素树上取**生产代码绑定的** onChange/onSubmit 回调，按 React「输入→重渲染→
// 提交」两步真实驱动。断言落在 localStorage 分键（gx-node-session:<nodeId>）、本地
// gx-auth 是否被污染、以及导航去向。
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as React from "react";
import type { UserDTO } from "@gx/shared-types";

// ── 模块 mock（必须在 import 组件前提升）─────────────────────────────────────
// 用 vi.hoisted 让被 mock 工厂闭包引用的 spy 先于（被提升的）import 求值，避开 TDZ。
const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));

vi.mock("../../../components/ui", () => ({
  // 占位组件：函数体不在本测试执行；props（placeholder/onChange 等）仍挂在元素树上供查找。
  Button: () => null,
  Input: () => null,
  SegmentedControl: () => null,
  toast: (...a: unknown[]) => h.toast(...a),
}));

vi.mock("../../../api/client", () => ({
  Auth: {
    login: vi.fn(),
    signup: vi.fn(),
    me: vi.fn(),
    changePassword: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API ${status}`);
    }
  },
}));

// 已初始化、不开放注册 → 纯登录形态（避免 bootstrap 分支与 react-query 探针）。
vi.mock("../login-bootstrap", async () => {
  const actual = await vi.importActual<typeof import("../login-bootstrap")>(
    "../login-bootstrap",
  );
  return {
    ...actual,
    useBootstrapStatus: () => ({ initialized: true, signupOpen: false }),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));

// 品牌左栏内部走 react-query 探针，与本测试关注点无关：用叶子隔掉。
vi.mock("../LoginBrandPanel", () => ({
  LoginBrandPanel: () => null,
}));

import { Auth } from "../../../api/client";
import LoginPage from "../LoginPage";
import ForceChangePassword from "../ForceChangePassword";
import { dataSourceResolver } from "../../../node/datasource";
import {
  getLauncherStore,
  __resetLauncherStoreForTest,
} from "../../../node/launcherStore";
import { remoteSessionKey } from "../../../node/remoteSessions";
import { useAuthStore } from "../../../store/auth";

const NODE_ID = "abc123def456";
const authMock = vi.mocked(Auth);
const navigate = h.navigate;
const toast = h.toast;
const invalidate = h.invalidate;

/** 间谍本地出口 setAuth：远端槽必须不触发，门控关/本地必须触发一次并写入。 */
function spySetAuth() {
  return vi.spyOn(useAuthStore.getState(), "setAuth");
}

const user = (over: Partial<UserDTO> = {}): UserDTO =>
  ({ id: "u1", email: "a@b.c", displayName: "A", ...over }) as UserDTO;

// ── 最小 Storage（localStorage + sessionStorage 同源）────────────────────────
class MapStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

// ── 迷你函数式渲染器：真实 dispatcher，真实执行组件函数体 ──────────────────────
const INTERNALS = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown };
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

let hookIdx = 0;
let hookSlots: unknown[] = [];

function dispatcher() {
  return {
    useState(init: unknown) {
      const i = hookIdx++;
      if (!(i in hookSlots)) {
        hookSlots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      }
      const setState = (v: unknown) => {
        hookSlots[i] =
          typeof v === "function" ? (v as (p: unknown) => unknown)(hookSlots[i]) : v;
      };
      return [hookSlots[i], setState];
    },
    // zustand v5 经 React.useSyncExternalStore 读 selector 快照；其 shim 还用到
    // useCallback（直接返回原函数）与 useDebugValue（no-op）。
    useSyncExternalStore: (_sub: unknown, get: () => unknown) => get(),
    useCallback: (fn: unknown) => fn,
    useDebugValue: () => undefined,
    useQueryClient: () => ({ invalidateQueries: h.invalidate }),
  };
}

type AnyEl = { type?: unknown; props?: Record<string, unknown> } | string | null;

function renderOnce(Comp: () => React.ReactElement): AnyEl {
  hookIdx = 0;
  const prev = INTERNALS.ReactCurrentDispatcher.current;
  INTERNALS.ReactCurrentDispatcher.current = dispatcher();
  try {
    return Comp() as unknown as AnyEl;
  } finally {
    INTERNALS.ReactCurrentDispatcher.current = prev;
  }
}

function walk(el: AnyEl, cb: (el: AnyEl) => void): void {
  if (!el || typeof el !== "object") return;
  cb(el);
  const children = (el.props as { children?: unknown })?.children;
  if (Array.isArray(children)) children.forEach((c) => walk(c as AnyEl, cb));
  else if (children != null && typeof children === "object")
    walk(children as AnyEl, cb);
}

function findPropsBy(
  root: AnyEl,
  pred: (p: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  let found: Record<string, unknown> | undefined;
  walk(root, (el) => {
    const p = (el as { props?: Record<string, unknown> })?.props;
    if (!found && p && pred(p)) found = p;
  });
  if (!found) throw new Error("未找到匹配的元素 props");
  return found;
}

function findForm(root: AnyEl): Record<string, unknown> {
  let form: Record<string, unknown> | undefined;
  walk(root, (el) => {
    if (!form && (el as { type?: unknown })?.type === "form") {
      form = (el as { props: Record<string, unknown> }).props;
    }
  });
  if (!form) throw new Error("未找到 form");
  return form;
}

const prevent = () => ({ preventDefault: () => undefined });

async function submitLogin(email: string, password: string): Promise<void> {
  let tree = renderOnce(LoginPage);
  (
    findPropsBy(tree, (p) => p.placeholder === "邮箱").onChange as (
      e: { target: { value: string } },
    ) => void
  )({ target: { value: email } });
  (
    findPropsBy(tree, (p) => p.placeholder === "密码").onChange as (
      e: { target: { value: string } },
    ) => void
  )({ target: { value: password } });
  // 输入后重渲染：新 form 闭包捕获最新 email/password（与 React 重渲染语义一致）
  tree = renderOnce(LoginPage);
  await (findForm(tree).onSubmit as (e: unknown) => void)(prevent());
}

async function submitChangePassword(cur: string, next: string): Promise<void> {
  let tree = renderOnce(ForceChangePassword);
  const by = (label: string) =>
    findPropsBy(tree!, (p) => p["aria-label"] === label).onChange as (
      e: { target: { value: string } },
    ) => void;
  by("当前密码")({ target: { value: cur } });
  by("新密码")({ target: { value: next } });
  by("确认新密码")({ target: { value: next } });
  tree = renderOnce(ForceChangePassword);
  await (findForm(tree).onSubmit as (e: unknown) => void)(prevent());
}

// ── 公共夹具 ──────────────────────────────────────────────────────────────────
// 文件级常驻内存 window：zustand persist（gx-auth）在模块创建后每次写入都读全局
// localStorage，故 window 必须在整个文件期间在场（不能用例中途才 stub，否则报
// storage unavailable）。vitest 按文件隔离环境，stub 不泄漏给其他测试文件。
const memLS = new MapStorage();
const memSS = new MapStorage();
let storage: MapStorage = memLS;

beforeAll(() => {
  vi.stubGlobal("window", {
    localStorage: memLS,
    sessionStorage: memSS,
    location: { origin: "http://127.0.0.1:7788" },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function resetAll() {
  hookSlots = [];
  hookIdx = 0;
  memLS.clear();
  memSS.clear();
  storage = memLS;
  navigate.mockReset();
  toast.mockReset();
  invalidate.mockReset();
  Object.values(authMock).forEach((fn) => fn.mockReset());
  vi.restoreAllMocks();
  useAuthStore.setState({ token: null, user: null });
  __resetLauncherStoreForTest();
  dataSourceResolver.setActive(null);
  vi.unstubAllEnvs();
}

/** 门控开 + 真实单例 store，并纯选路到一个远端（remote-empty）。 */
async function routeToRemoteEmpty() {
  vi.stubEnv("VITE_NODE_LAUNCHER", "1");
  const store = getLauncherStore({
    resolver: dataSourceResolver,
    getLocalBase: () => "",
    getOrigin: () => "http://127.0.0.1:7788",
    getLocalToken: () => null,
  });
  store.addRemote({ nodeId: NODE_ID, baseURL: "http://nas:3001" });
  await store.connectRemote(NODE_ID); // 无凭据纯选路 → token=null
  return store;
}

function remoteEnvelope() {
  return JSON.parse(storage.getItem(remoteSessionKey(NODE_ID)) as string) as {
    version: number;
    token: string;
    user: UserDTO;
  };
}

beforeEach(resetAll);
afterEach(resetAll);

describe("remote-empty 下远端自己的登录页提交（门控开）", () => {
  it("登录成功：JWT 落 gx-node-session 分键、本地 gx-auth 不被写、导航 /", async () => {
    await routeToRemoteEmpty();
    expect(dataSourceResolver.current().token).toBeNull();
    const setAuth = spySetAuth();
    authMock.login.mockResolvedValue({
      token: "remote-jwt",
      user: user({ mustChangePassword: false }),
    });

    await submitLogin("a@b.c", "secret123");

    // 远端分键被写入
    const env = remoteEnvelope();
    expect(env.version).toBe(1);
    expect(env.token).toBe("remote-jwt");
    expect(env.user.mustChangePassword).toBe(false);
    // 活动数据源重推为带 JWT
    expect(dataSourceResolver.current().kind).toBe("remote");
    expect(dataSourceResolver.current().token).toBe("remote-jwt");
    // 本地真相源零污染：setAuth 本地出口一次都不触发，内存态 token 仍为 null
    expect(setAuth).not.toHaveBeenCalled();
    expect(useAuthStore.getState().token).toBeNull();
    // 即便存在初始空 gx-auth 信封，其 token 也绝不能被远端 JWT 污染
    const gx = memLS.getItem("gx-auth");
    if (gx) expect(JSON.parse(gx).state.token).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("登录返回 mustChangePassword=true：写远端分键后导航 /change-password", async () => {
    await routeToRemoteEmpty();
    const setAuth = spySetAuth();
    authMock.login.mockResolvedValue({
      token: "remote-jwt",
      user: user({ mustChangePassword: true }),
    });

    await submitLogin("a@b.c", "secret123");

    expect(remoteEnvelope().user.mustChangePassword).toBe(true);
    expect(setAuth).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/change-password");
  });
});

describe("门控关 / 活动源本地：现网行为零变化", () => {
  it("登录仍写本地 gx-auth（setAuth + persist 落盘），不产生任何远端会话分键", async () => {
    // 门控保持关闭（不 stub VITE_NODE_LAUNCHER），window 由文件级夹具常驻提供
    const setAuth = spySetAuth();
    const localUser = user({ mustChangePassword: false });
    authMock.login.mockResolvedValue({ token: "local-jwt", user: localUser });

    await submitLogin("a@b.c", "secret123");

    // 本地出口被调用一次，参数即登录返回（现网行为）
    expect(setAuth).toHaveBeenCalledTimes(1);
    expect(setAuth).toHaveBeenCalledWith("local-jwt", localUser);
    expect(useAuthStore.getState().token).toBe("local-jwt");
    // 没有任何远端会话分键
    expect(memLS.getItem(remoteSessionKey(NODE_ID))).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/");
  });
});

describe("remote 会话下 ForceChangePassword 改密成功（门控开）", () => {
  it("me() 成功：用当前 resolver token + 新 user 重写远端分键，gx-auth 不写，导航 /", async () => {
    await routeToRemoteEmpty();
    // 先以 mustChangePassword=true 登录，拿到活动远端 JWT
    authMock.login.mockResolvedValue({
      token: "remote-jwt",
      user: user({ mustChangePassword: true }),
    });
    await submitLogin("a@b.c", "secret123");
    expect(dataSourceResolver.current().token).toBe("remote-jwt");

    const setAuth = spySetAuth();
    authMock.changePassword.mockResolvedValue({ ok: true });
    authMock.me.mockResolvedValue({
      user: user({ mustChangePassword: false, displayName: "新名字" }),
    });
    await submitChangePassword("secret123", "brandnew1");

    const env = remoteEnvelope();
    expect(env.token).toBe("remote-jwt"); // 改密不换发：沿用当前 resolver token
    expect(env.user.mustChangePassword).toBe(false);
    expect(env.user.displayName).toBe("新名字");
    expect(setAuth).not.toHaveBeenCalled(); // 不落本地 gx-auth
    expect(navigate).toHaveBeenCalledWith("/");
    expect(invalidate).toHaveBeenCalled();
  });

  it("me() reject：走 patchRemoteSessionUser 就地把 mustChangePassword 补为 false，token 沿用", async () => {
    await routeToRemoteEmpty();
    authMock.login.mockResolvedValue({
      token: "remote-jwt",
      user: user({ mustChangePassword: true }),
    });
    await submitLogin("a@b.c", "secret123");

    const setAuth = spySetAuth();
    authMock.changePassword.mockResolvedValue({ ok: true });
    authMock.me.mockRejectedValue(new Error("network"));
    await submitChangePassword("secret123", "brandnew1");

    const env = remoteEnvelope();
    expect(env.token).toBe("remote-jwt");
    expect(env.user.mustChangePassword).toBe(false);
    expect(env.user.id).toBe("u1");
    expect(setAuth).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/");
  });
});


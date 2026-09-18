// 登录页「首运行创建超级管理员」分支回归（node：react-dom/server + vi.mock，无 jsdom/新依赖，
// 沿 PatListPanel.test.tsx 套路）。覆盖：
//   - 纯判定：空库→引导 / 已初始化→现状 / 探针失败→降级 / signupOpen=false 隐藏注册 tab
//   - 引导表单校验（与后端 signupSchema 对齐）与失败文案收敛
//   - LoginPage 四种形态的真实渲染分支
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString as rtsRaw } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// 登录页只用到 useNavigate 做跳转：SSR 下不必挂真实 Router（MemoryRouter 的
// useLayoutEffect 会在服务端渲染刷告警），给一个空实现即可。
vi.mock("react-router-dom", () => ({ useNavigate: () => () => undefined }));

// 请求层：禁真实 fetch。bootstrap 探针与 signup 都由 mock 驱动。
vi.mock("../../../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API ${status}`);
    }
  },
  fetchBootstrapStatus: vi.fn(),
  Auth: { signup: vi.fn(), login: vi.fn() },
}));

import { fetchBootstrapStatus, type BootstrapStatus } from "../../../api/client";
import {
  BOOTSTRAP_STATUS_QK,
  DEGRADED_LOGIN_ENTRY,
  friendlyBootstrapError,
  loadBootstrapStatus,
  resolveLoginEntry,
  validateBootstrapForm,
} from "../login-bootstrap";
import LoginPage from "../LoginPage";

const bootstrapStatusMock = vi.mocked(fetchBootstrapStatus);

/** 用预置的探针数据渲染登录页（SSR 首帧即取缓存，等价于挂载后拿到响应的稳态） */
function render(status: BootstrapStatus | null): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  qc.setQueryData(BOOTSTRAP_STATUS_QK, status);
  return rtsRaw(
    <QueryClientProvider client={qc}>
      <LoginPage />
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

const OK: BootstrapStatus = { initialized: true, signupOpen: true };

beforeEach(() => {
  bootstrapStatusMock.mockReset();
});

describe("resolveLoginEntry（登录页形态判定）", () => {
  it("空库（initialized=false）→ 创建超级管理员引导，不给登录/注册 tab", () => {
    expect(resolveLoginEntry({ initialized: false, signupOpen: true })).toEqual({
      bootstrap: true,
      signupVisible: false,
    });
  });

  it("已初始化 → 现状（登录 + 注册）", () => {
    expect(resolveLoginEntry(OK)).toEqual({ bootstrap: false, signupVisible: true });
  });

  it("已初始化但 signupOpen=false → 隐藏注册 tab", () => {
    expect(resolveLoginEntry({ initialized: true, signupOpen: false })).toEqual({
      bootstrap: false,
      signupVisible: false,
    });
  });

  it("探针未完成/失败（null）→ 降级为现状，不卡住用户", () => {
    expect(resolveLoginEntry(null)).toEqual(DEGRADED_LOGIN_ENTRY);
    expect(resolveLoginEntry(undefined)).toEqual(DEGRADED_LOGIN_ENTRY);
  });
});

describe("validateBootstrapForm（引导表单校验，对齐后端 signupSchema）", () => {
  const base = { email: "admin@example.com", displayName: "管理员", password: "gxpass123", confirmPassword: "gxpass123" };

  it("合法输入通过", () => {
    expect(validateBootstrapForm(base)).toBeNull();
  });

  it("邮箱缺失 / 格式不合法", () => {
    expect(validateBootstrapForm({ ...base, email: "  " })).toBe("请输入邮箱");
    expect(validateBootstrapForm({ ...base, email: "admin#example.com" })).toBe("邮箱格式不正确");
  });

  it("昵称为空（后端 displayName min(1) 强制必填）", () => {
    expect(validateBootstrapForm({ ...base, displayName: "" })).toBe("请输入昵称");
  });

  it("密码缺失 / 短于 8 位", () => {
    expect(validateBootstrapForm({ ...base, password: "", confirmPassword: "" })).toBe("请输入密码");
    expect(validateBootstrapForm({ ...base, password: "1234567", confirmPassword: "1234567" })).toBe("密码至少 8 位");
    expect(validateBootstrapForm({ ...base, password: "12345678", confirmPassword: "12345678" })).toBeNull();
  });

  it("两次密码不一致", () => {
    expect(validateBootstrapForm({ ...base, confirmPassword: "gxpass124" })).toBe("两次输入的密码不一致");
  });
});

describe("friendlyBootstrapError（失败文案收敛为中文）", () => {
  const apiErr = (status: number) =>
    new (class extends Error {
      status = status;
    })(`API ${status}`) as unknown as Error & { status: number };

  it("常见状态码给可执行提示", () => {
    expect(friendlyBootstrapError(apiErr(409))).toBe("该邮箱已被注册，请更换邮箱或直接登录");
    expect(friendlyBootstrapError(apiErr(400))).toBe("输入有误：请检查邮箱格式，密码至少 8 位");
    expect(friendlyBootstrapError(apiErr(403))).toBe("注册入口已关闭，请联系管理员");
    expect(friendlyBootstrapError(apiErr(429))).toBe("操作过于频繁，请稍后再试");
  });

  it("5xx / 非 ApiError（网络异常）不外抛英文原始串", () => {
    expect(friendlyBootstrapError(apiErr(500))).toBe("服务端异常，请稍后重试");
    expect(friendlyBootstrapError(new Error("fetch failed"))).toBe("网络异常，请检查服务是否已启动");
    expect(friendlyBootstrapError("boom")).toBe("网络异常，请检查服务是否已启动");
  });
});

describe("loadBootstrapStatus（探针失败降级）", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("成功：原样返回状态", async () => {
    bootstrapStatusMock.mockResolvedValue(OK);
    await expect(loadBootstrapStatus()).resolves.toEqual(OK);
  });

  it("失败：返回 null（登录页据此降级）并留下告警", async () => {
    bootstrapStatusMock.mockRejectedValue(new Error("fetch failed"));
    await expect(loadBootstrapStatus()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("LoginPage 四种形态渲染", () => {
  it("未初始化 → 只渲染创建超级管理员引导，不出现登录/注册 tab", () => {
    const html = render({ initialized: false, signupOpen: true });
    expect(html).toContain("初始化工作台 · 创建超级管理员");
    expect(html).toContain("它将自动成为超级管理员");
    expect(html).toContain("创建超级管理员并进入");
    // 四个字段：昵称 / 邮箱 / 密码 / 确认密码
    expect(html).toContain('placeholder="昵称"');
    expect(html).toContain('placeholder="邮箱"');
    expect(html).toContain('placeholder="确认密码"');
    // 引导态下没有 tab 与「去注册」入口
    expect(html).not.toContain(">注册<");
    expect(html).not.toContain(">登录<");
    expect(html).not.toContain("没有账号？去注册");
  });

  it("已初始化 → 维持现状（登录/注册 tabs）", () => {
    const html = render(OK);
    expect(html).toContain(">登录<");
    expect(html).toContain(">注册<");
    expect(html).toContain("没有账号？去注册");
    expect(html).not.toContain("确认密码");
    expect(html).not.toContain("创建超级管理员");
  });

  it("探针失败（无数据）→ 降级为现状登录页", () => {
    const html = render(null);
    expect(html).toContain(">登录<");
    expect(html).toContain(">注册<");
    expect(html).not.toContain("创建超级管理员");
  });

  it("signupOpen=false → 只剩登录，隐藏注册 tab 与去注册入口", () => {
    const html = render({ initialized: true, signupOpen: false });
    expect(html).toContain("登录");
    expect(html).not.toContain(">注册<");
    expect(html).not.toContain("没有账号？去注册");
    expect(html).not.toContain("创建超级管理员");
  });
});

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
  // 品牌左栏（LoginBrandPanel → useBranding）会触达品牌探针与 withBase；
  // 探针给默认 DTO（产品名走 DEFAULT_BRANDING），withBase 恒等即可。
  Branding: {
    publicConfig: vi
      .fn()
      .mockResolvedValue({
        productName: "构想工作台",
        copyright: "",
        heroUrl: null,
      }),
  },
  withBase: (p: string) => p,
}));

import {
  fetchBootstrapStatus,
  type BootstrapStatus,
} from "../../../api/client";
import { QK } from "../../../api/hooks";
import type { BrandingConfigDTO } from "@gx/shared-types";
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
function render(
  status: BootstrapStatus | null,
  branding?: BrandingConfigDTO,
): string {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  qc.setQueryData(BOOTSTRAP_STATUS_QK, status);
  if (branding) qc.setQueryData(QK.branding, branding);
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
    expect(resolveLoginEntry({ initialized: false, signupOpen: true })).toEqual(
      {
        bootstrap: true,
        signupVisible: false,
      },
    );
  });

  it("已初始化 + 后端显式 signupOpen=true → 登录 + 注册", () => {
    expect(resolveLoginEntry(OK)).toEqual({
      bootstrap: false,
      signupVisible: true,
    });
  });

  it("已初始化 + signupOpen=false → 隐藏注册 tab", () => {
    expect(resolveLoginEntry({ initialized: true, signupOpen: false })).toEqual(
      {
        bootstrap: false,
        signupVisible: false,
      },
    );
  });

  it("已初始化但 signupOpen 字段缺失 → fail-closed，不给注册入口", () => {
    const noFlag = { initialized: true } as BootstrapStatus;
    expect(resolveLoginEntry(noFlag)).toEqual({
      bootstrap: false,
      signupVisible: false,
    });
  });

  it("探针未完成/失败（null/undefined）→ 降级为纯登录，不误显示自注册", () => {
    expect(resolveLoginEntry(null)).toEqual(DEGRADED_LOGIN_ENTRY);
    expect(resolveLoginEntry(undefined)).toEqual(DEGRADED_LOGIN_ENTRY);
    expect(DEGRADED_LOGIN_ENTRY).toEqual({
      bootstrap: false,
      signupVisible: false,
    });
  });
});

describe("validateBootstrapForm（引导表单校验，对齐后端 signupSchema）", () => {
  const base = {
    email: "admin@example.com",
    displayName: "管理员",
    password: "gxpass123",
    confirmPassword: "gxpass123",
  };

  it("合法输入通过", () => {
    expect(validateBootstrapForm(base)).toBeNull();
  });

  it("邮箱缺失 / 格式不合法", () => {
    expect(validateBootstrapForm({ ...base, email: "  " })).toBe("请输入邮箱");
    expect(validateBootstrapForm({ ...base, email: "admin#example.com" })).toBe(
      "邮箱格式不正确",
    );
  });

  it("昵称为空（后端 displayName min(1) 强制必填）", () => {
    expect(validateBootstrapForm({ ...base, displayName: "" })).toBe(
      "请输入昵称",
    );
  });

  it("密码缺失 / 短于 8 位", () => {
    expect(
      validateBootstrapForm({ ...base, password: "", confirmPassword: "" }),
    ).toBe("请输入密码");
    expect(
      validateBootstrapForm({
        ...base,
        password: "1234567",
        confirmPassword: "1234567",
      }),
    ).toBe("密码至少 8 位");
    expect(
      validateBootstrapForm({
        ...base,
        password: "12345678",
        confirmPassword: "12345678",
      }),
    ).toBeNull();
  });

  it("两次密码不一致", () => {
    expect(
      validateBootstrapForm({ ...base, confirmPassword: "gxpass124" }),
    ).toBe("两次输入的密码不一致");
  });
});

describe("friendlyBootstrapError（失败文案收敛为中文）", () => {
  const apiErr = (status: number) =>
    new (class extends Error {
      status = status;
    })(`API ${status}`) as unknown as Error & { status: number };

  it("常见状态码给可执行提示", () => {
    expect(friendlyBootstrapError(apiErr(409))).toBe(
      "该邮箱已被注册，请更换邮箱或直接登录",
    );
    expect(friendlyBootstrapError(apiErr(400))).toBe(
      "输入有误：请检查邮箱格式，密码至少 8 位",
    );
    expect(friendlyBootstrapError(apiErr(403))).toBe(
      "注册入口已关闭，请联系管理员",
    );
    expect(friendlyBootstrapError(apiErr(429))).toBe(
      "操作过于频繁，请稍后再试",
    );
  });

  it("5xx / 非 ApiError（网络异常）不外抛英文原始串", () => {
    expect(friendlyBootstrapError(apiErr(500))).toBe("服务端异常，请稍后重试");
    expect(friendlyBootstrapError(new Error("fetch failed"))).toBe(
      "网络异常，请检查服务是否已启动",
    );
    expect(friendlyBootstrapError("boom")).toBe(
      "网络异常，请检查服务是否已启动",
    );
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
    // 标题/副标题拆为两行（双栏右栏版式）
    expect(html).toContain("初始化工作台");
    expect(html).toContain("创建超级管理员");
    expect(html).toContain("它将自动成为超级管理员");
    expect(html).toContain("创建超级管理员并进入");
    // 四个字段：昵称 / 邮箱 / 密码 / 确认密码
    expect(html).toContain('placeholder="昵称"');
    expect(html).toContain('placeholder="邮箱"');
    expect(html).toContain('placeholder="确认密码"');
    // 引导态下没有欢迎标题、tab 与「去注册」入口
    expect(html).not.toContain("欢迎登录");
    expect(html).not.toContain(">注册<");
    expect(html).not.toContain(">登录<");
    expect(html).not.toContain("没有账号？去注册");
  });

  it("已初始化 + signupOpen=true → 显示登录/注册 tabs（企业部署下需后端显式开放）", () => {
    const html = render(OK);
    expect(html).toContain(">登录<");
    expect(html).toContain(">注册<");
    expect(html).toContain("没有账号？去注册");
    expect(html).not.toContain("确认密码");
    expect(html).not.toContain("创建超级管理员");
  });

  it("探针失败（无数据）→ fail-closed，降级为纯登录页，不给自注册入口", () => {
    const html = render(null);
    // 无 tab 时右栏给「欢迎登录」标题（旧版是孤立的「登录」二字）
    expect(html).toContain("欢迎登录");
    expect(html).not.toContain(">注册<");
    expect(html).not.toContain("没有账号？去注册");
    expect(html).not.toContain("创建超级管理员");
  });

  it("signupOpen 字段缺失（老后端）→ 按关闭处理，只剩登录", () => {
    const html = render({ initialized: true } as BootstrapStatus);
    expect(html).toContain("欢迎登录");
    expect(html).not.toContain(">注册<");
    expect(html).not.toContain("没有账号？去注册");
  });

  it("signupOpen=false → 只剩登录，隐藏注册 tab 与去注册入口", () => {
    const html = render({ initialized: true, signupOpen: false });
    expect(html).toContain("登录");
    expect(html).not.toContain(">注册<");
    expect(html).not.toContain("没有账号？去注册");
    expect(html).not.toContain("创建超级管理员");
  });
});

describe("LoginPage 双栏改版（#753）", () => {
  it("桌面形态：品牌左栏（hidden md:flex）+ 广告图 + 右栏欢迎标题同帧出现", () => {
    const html = render(OK);
    expect(html).toContain("login-brand-panel");
    // 左栏：默认 hidden（窄屏单栏只留表单），md 起 flex（桌面双栏）
    expect(html).toMatch(/login-brand-panel[^>]*class="[^"]*\bhidden\b/);
    expect(html).toMatch(/login-brand-panel[^>]*class="[^"]*\bmd:flex\b/);
    expect(html).toContain('alt=""');
    expect(html).toContain("欢迎登录");
    // 左栏定位小字与标语（页面叠加，不烧死在图里）
    expect(html).toContain("私有部署 · 数据自主");
    expect(html).toContain("智能表格、知识库与画布一体化");
  });

  it("密码框：默认掩码 type=password，并带眼睛切换按钮（aria-label 显隐）", () => {
    const html = render(OK);
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="显示密码"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("品牌产品名注入左栏大标题；右栏不重复出现旧版居中产品名块", () => {
    const html = render(OK, {
      productName: "星表私有云",
      copyright: "",
      heroUrl: null,
    });
    expect(html).toContain("星表私有云");
    // 旧副标题开发味文案彻底消失
    expect(html).not.toContain("前后端分离重写");
  });

  it("配置了版权串 → 左栏底部渲染；{year} 占位替换为当前年份", () => {
    const html = render(OK, {
      productName: "构想工作台",
      copyright: "© {year} 构想科技",
      heroUrl: null,
    });
    expect(html).toContain(`© ${new Date().getFullYear()} 构想科技`);
  });

  it("自定义广告图：heroUrl 经 withBase 后进入 img src（子路径部署前缀由 withBase 负责）", () => {
    const html = render(OK, {
      productName: "构想工作台",
      copyright: "",
      heroUrl: "/uploads/branding/hero-abc.png",
    });
    expect(html).toContain('src="/uploads/branding/hero-abc.png"');
  });
});

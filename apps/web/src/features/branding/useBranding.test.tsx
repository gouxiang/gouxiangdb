// useBranding 契约测试（node 环境：react-dom/server + 真实 QueryClient，无 jsdom、无新依赖，
// 沿 login-bootstrap.test.tsx 的 SSR 套路）。覆盖：
//   - 公开探针成功 → useProductName/useHeroUrl/useCopyright 取缓存配置；
//   - 公开探针失败/首帧 → placeholderData 兜底 DEFAULT_BRANDING（产品名仍为默认名）；
//   - heroUrl=null → 内置默认图（以 branding/login-hero.png 结尾）；非 null → 过 withBase；
//   - 管理员三个 mutation 成功后 invalidate ["branding"]（公开/管理员共享缓存键，全站即时生效）；
//   - Copyright 空版权渲染 null、{year} 渲染；BrandingTitle SSR 无 UI（useEffect 在浏览器执行）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrandingConfigDTO, BrandingUpdateInput } from "@gx/shared-types";

// vi.mock 工厂被提升到文件顶部，mock fn 必须用 vi.hoisted 同步提升，否则初始化顺序报错。
const mocks = vi.hoisted(() => ({
  publicConfig: vi.fn(),
  adminConfig: vi.fn(),
  update: vi.fn(),
  uploadHero: vi.fn(),
  resetHero: vi.fn(),
}));
const { publicConfig, adminConfig, update, uploadHero, resetHero } = mocks;

vi.mock("../../api/client", () => ({
  Branding: {
    publicConfig: mocks.publicConfig,
    adminConfig: mocks.adminConfig,
    update: mocks.update,
    uploadHero: mocks.uploadHero,
    resetHero: mocks.resetHero,
  },
  // 根部署：withBase 原样返回；子路径拼法另有 lib/base 单测覆盖。
  withBase: (p: string) => p,
}));

import { QK } from "../../api/hooks";
import {
  useBranding,
  useProductName,
  useHeroUrl,
  useCopyright,
  useBrandingAdmin,
  DEFAULT_HERO_URL,
} from "./useBranding";
import { Copyright } from "./Copyright";
import { BrandingTitle } from "./BrandingTitle";
import { DEFAULT_BRANDING } from "./branding-text";

function withClient(qc: QueryClient, node: ReactNode): string {
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const CUSTOM: BrandingConfigDTO = {
  productName: "定制品牌名",
  copyright: "© {year} 定制公司",
  heroUrl: "/uploads/branding/hero.png?v=1728000000",
  signupOpen: true,
  serverBaseUrl: "https://gx.example.com",
};

/** SSR 下把 hook 结果拍成一行文本断言。 */
function Probe({ kind }: { kind: "name" | "hero" | "copyright" | "data" }) {
  const branding = useBranding();
  const name = useProductName();
  const hero = useHeroUrl();
  const copyright = useCopyright();
  const value =
    kind === "name"
      ? name
      : kind === "hero"
        ? hero
        : kind === "copyright"
          ? copyright
          : JSON.stringify(branding.data);
  return <span>{value}</span>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useBranding 公开探针", () => {
  it("缓存有配置 → 产品名/版权/广告图全部取后台值（{year} 已替换为当前年）", () => {
    const qc = makeClient();
    qc.setQueryData(QK.branding, CUSTOM);
    expect(withClient(qc, <Probe kind="name" />)).toContain("定制品牌名");
    expect(withClient(qc, <Probe kind="copyright" />)).toContain(
      `© ${new Date().getFullYear()} 定制公司`,
    );
    expect(withClient(qc, <Probe kind="hero" />)).toContain(
      "/uploads/branding/hero.png?v=1728000000",
    );
    expect(withClient(qc, <Probe kind="data" />)).toContain("定制品牌名");
    // 缓存命中不发请求
    expect(publicConfig).not.toHaveBeenCalled();
  });

  it("首帧（查询进行中）→ placeholderData 兜底默认产品名，消费方无需判空", () => {
    const qc = makeClient();
    // 永不落定的 queryFn，模拟首帧 pending
    publicConfig.mockImplementation(
      () => new Promise<BrandingConfigDTO>(() => undefined),
    );
    const html = withClient(qc, <Probe kind="name" />);
    expect(html).toContain(DEFAULT_BRANDING.productName);
  });

  it("探针失败 → data 仍是 DEFAULT_BRANDING（retry:0，错误不吞掉产品名展示）", async () => {
    const qc = makeClient();
    publicConfig.mockRejectedValue(new Error("network down"));
    // 先把查询跑到 error 态（fetchQuery 会把错误抛给调用方），再验证渲染兜底
    await expect(
      qc.fetchQuery({ queryKey: QK.branding, queryFn: () => publicConfig() }),
    ).rejects.toThrow("network down");
    const html = withClient(qc, <Probe kind="name" />);
    expect(html).toContain("构想工作台");
  });

  it("heroUrl=null → 内置默认图地址（以 branding/login-hero.png 结尾，非 withBase 通道）", () => {
    const qc = makeClient();
    qc.setQueryData(QK.branding, { ...CUSTOM, heroUrl: null });
    const html = withClient(qc, <Probe kind="hero" />);
    expect(html).toMatch(/branding\/login-hero\.png<\/span>/);
    expect(html).not.toContain("/uploads/");
    expect(DEFAULT_HERO_URL.endsWith("branding/login-hero.png")).toBe(true);
  });

  it("空版权串 → useCopyright 返回空串（Copyright 组件渲染 null）", () => {
    const qc = makeClient();
    qc.setQueryData(QK.branding, { ...CUSTOM, copyright: "" });
    expect(withClient(qc, <Probe kind="copyright" />)).toBe("<span></span>");
    expect(withClient(qc, <Copyright />)).toBe("");
  });
});

describe("Copyright / BrandingTitle 组件", () => {
  it("有版权 → 渲染 <p>，{year} 已替换", () => {
    const qc = makeClient();
    qc.setQueryData(QK.branding, CUSTOM);
    const html = withClient(qc, <Copyright className="foot" />);
    expect(html).toBe(
      `<p class="foot">© ${new Date().getFullYear()} 定制公司</p>`,
    );
  });

  it("BrandingTitle 不渲染任何 UI（document.title 由浏览器端 useEffect 设置）", () => {
    const qc = makeClient();
    expect(withClient(qc, <BrandingTitle />)).toBe("");
  });
});

// ---- 管理员 mutation：SSR 渲染时把 mutation 句柄抓到 holder，再在 node 里调 mutateAsync ----
// mutateAsync/onSuccess 不依赖 DOM（纯 Promise + queryClient 调用），故无 jsdom 也可断言失效策略。
// 用方法简写声明：strictFunctionTypes 下方法签名双变，既能接收真实 mutation 对象，
// 调用点也有入参类型（update 有入参，reset 无参）。
interface AdminHolder {
  updateBranding?: { mutateAsync(data: BrandingUpdateInput): Promise<unknown> };
  uploadHero?: { mutateAsync(file: File): Promise<unknown> };
  resetHero?: { mutateAsync(): Promise<unknown> };
  setSignupOpen?: { mutateAsync(open: boolean): Promise<unknown> };
}

function AdminProbe({
  holder,
  enabled,
}: {
  holder: AdminHolder;
  enabled: boolean;
}) {
  const admin = useBrandingAdmin({ enabled });
  holder.updateBranding = admin.updateBranding;
  holder.uploadHero = admin.uploadHero;
  holder.resetHero = admin.resetHero;
  holder.setSignupOpen = admin.setSignupOpen;
  return <span>admin</span>;
}

describe("useBrandingAdmin：写成功后失效共享 branding 缓存（全站即时生效）", () => {
  it('update 成功 → invalidateQueries({queryKey:["branding"]})', async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    update.mockResolvedValue(CUSTOM);
    const holder: AdminHolder = {};
    withClient(qc, <AdminProbe holder={holder} enabled={false} />);

    await holder.updateBranding!.mutateAsync({ productName: "新名字" });
    expect(update).toHaveBeenCalledWith({ productName: "新名字" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: QK.branding });
  });

  it("uploadHero 成功 → 同样失效 branding 键，且把 File 透传给 client", async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    uploadHero.mockResolvedValue(CUSTOM);
    const holder: AdminHolder = {};
    withClient(qc, <AdminProbe holder={holder} enabled={false} />);

    const file = new File(["x"], "hero.png", { type: "image/png" });
    await holder.uploadHero!.mutateAsync(file);
    expect(uploadHero).toHaveBeenCalledWith(file);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: QK.branding });
  });

  it("resetHero 成功 → 同样失效 branding 键", async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    resetHero.mockResolvedValue(DEFAULT_BRANDING);
    const holder: AdminHolder = {};
    withClient(qc, <AdminProbe holder={holder} enabled={false} />);

    await holder.resetHero!.mutateAsync();
    expect(resetHero).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: QK.branding });
  });

  it("enabled=false → 不发起管理员读请求（非管理员 fail-closed，不靠后端 403 隐入口）", () => {
    const qc = makeClient();
    withClient(qc, <AdminProbe holder={{}} enabled={false} />);
    expect(adminConfig).not.toHaveBeenCalled();
  });

  it("setSignupOpen(true) → 仅 PATCH {signupOpen:true}，成功后失效 branding 键", async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    update.mockResolvedValue({ ...CUSTOM, signupOpen: true });
    const holder: AdminHolder = {};
    withClient(qc, <AdminProbe holder={holder} enabled={false} />);

    await holder.setSignupOpen!.mutateAsync(true);
    expect(update).toHaveBeenCalledWith({ signupOpen: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: QK.branding });
  });

  it("setSignupOpen(false) → 仅 PATCH {signupOpen:false}（关闭自主注册）", async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    update.mockResolvedValue({ ...CUSTOM, signupOpen: false });
    const holder: AdminHolder = {};
    withClient(qc, <AdminProbe holder={holder} enabled={false} />);

    await holder.setSignupOpen!.mutateAsync(false);
    expect(update).toHaveBeenCalledWith({ signupOpen: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: QK.branding });
  });
});

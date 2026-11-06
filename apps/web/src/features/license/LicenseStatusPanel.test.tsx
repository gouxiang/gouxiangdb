// 授权面板组件 SSR 回归（node：react-dom/server，无 jsdom/新依赖，沿 PatListPanel.test 套路）。
// 覆盖：verdictLabel 直出、seats=null 显「不限席位数」、off 降级、非管理员不渲染管理区、
//       管理员渲染「立即同步/离线激活/联系信息」、不渲染授权中心 URL 与密钥输入框、到期日与指纹展示。
import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import type { LicenseStatusDTO } from "@gx/shared-types";

// 数据 hook 全部桩掉：组件只应关心渲染事实，不打真实 fetch/query。
const statusMock = vi.fn();
vi.mock("./license-hooks", () => ({
  useLicenseStatus: () => statusMock(),
  useSync: () => ({ isPending: false, mutate: vi.fn() }),
  useImportOffline: () => ({ isPending: false, mutate: vi.fn() }),
  useSaveContact: () => ({ isPending: false, mutate: vi.fn() }),
}));

import { LicenseStatusPanel } from "./LicenseStatusPanel";
import { LicenseAdvanced } from "./LicenseAdvanced";

beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  g.document = g.document ?? { body: {} };
});

function rts(node: ReactElement): string {
  return rtsRaw(node).replace(/<!--[^>]*-->/g, "");
}

const SECRET_URL = "https://license.example";

function status(over: Partial<LicenseStatusDTO> = {}): {
  data: LicenseStatusDTO;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  return {
    data: {
      available: true,
      mode: "enforce",
      verdict: "licensed",
      verdictLabel: "商业版已授权",
      seats: 10,
      usedSeats: 3,
      isAdmin: false,
      adminEmail: null,
      orgName: "某科技有限公司",
      licensedTo: "某科技有限公司",
      expiresAt: 1760000000,
      version: 3,
      everCommercial: true,
      fingerprintShort: "a1b2c3d4e5f6",
      // 即便后端回了 baseUrl，前端也绝不渲染它。
      baseUrl: SECRET_URL,
      online: true,
      lastHeartbeatAt: 1_760_000_000_000,
      lastAttemptAt: 1_760_000_000_000,
      syncing: false,
      deploymentId: "dep-1",
      platform: "linux",
      feedback: { unread: 0, open: 0 },
      ...over,
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: () => {},
  };
}

describe("LicenseStatusPanel", () => {
  it("verdictLabel 直出后端中文，席位显示 used/seats", () => {
    statusMock.mockReturnValue(status());
    const html = rts(<LicenseStatusPanel />);
    expect(html).toContain("商业版已授权");
    expect(html).toContain("3 / 10");
    expect(html).toContain("某科技有限公司");
    expect(html).toContain("a1b2c3d4e5f6");
    // 到期日（epoch 秒 → 本地 YYYY-MM-DD）
    expect(html).toMatch(/2025-\d{2}-\d{2}/);
  });

  it("绝不渲染授权中心地址（baseUrl），但在线态显连接状态", () => {
    statusMock.mockReturnValue(status());
    const html = rts(<LicenseStatusPanel />);
    expect(html).not.toContain(SECRET_URL);
    expect(html).not.toContain("授权中心地址");
    expect(html).toContain("已连接授权中心");
  });

  it("seats=null 显示「不限席位数」，不出现进度数字", () => {
    statusMock.mockReturnValue(status({ seats: null, usedSeats: null }));
    const html = rts(<LicenseStatusPanel />);
    expect(html).toContain("不限席位数");
    expect(html).not.toContain("/ 10");
  });

  it("席位已满时给出红色续费提示", () => {
    statusMock.mockReturnValue(status({ seats: 5, usedSeats: 5 }));
    const html = rts(<LicenseStatusPanel />);
    expect(html).toContain("5 / 5");
    expect(html).toContain("席位已满");
  });

  it("从未成功同步：显「尚未同步」而非在线", () => {
    statusMock.mockReturnValue(status({ online: false, lastHeartbeatAt: null }));
    const html = rts(<LicenseStatusPanel />);
    expect(html).toContain("尚未同步");
  });

  it("off / available=false：降级为一句说明，不显席位事实与指纹", () => {
    statusMock.mockReturnValue(
      status({
        available: false,
        mode: "off",
        verdict: "bypassed",
        verdictLabel: "未启用授权",
        seats: null,
        usedSeats: null,
        fingerprintShort: "",
        baseUrl: "",
        online: false,
        lastHeartbeatAt: null,
        lastAttemptAt: null,
        deploymentId: null,
        platform: null,
        licensedTo: null,
        orgName: null,
        expiresAt: null,
        version: null,
      }),
    );
    const html = rts(<LicenseStatusPanel />);
    expect(html).toContain("未启用商业授权");
    expect(html).not.toContain("席位使用");
    expect(html).not.toContain("设备指纹");
  });

  it("加载态：不渲染事实面板", () => {
    statusMock.mockReturnValue({ ...status(), isLoading: true, data: undefined });
    const html = rts(<LicenseStatusPanel />);
    expect(html).toContain("正在读取授权状态");
  });
});

describe("LicenseAdvanced 门控与零输入", () => {
  it("非管理员：整块不渲染（null）", () => {
    statusMock.mockReturnValue(status({ isAdmin: false }));
    expect(rts(<LicenseAdvanced />)).toBe("");
  });

  it("授权未启用：整块不渲染，即使是管理员", () => {
    statusMock.mockReturnValue(status({ available: false, isAdmin: true }));
    expect(rts(<LicenseAdvanced />)).toBe("");
  });

  it("管理员 + available：渲染立即同步/离线激活/联系信息，无任何密钥输入框", () => {
    statusMock.mockReturnValue(
      status({ isAdmin: true, fingerprint: "a1b2c3d4e5f600112233445566778899aabbccdd" }),
    );
    const html = rts(<LicenseAdvanced />);
    // 新三块
    expect(html).toContain("立即同步");
    expect(html).toContain("离线激活");
    expect(html).toContain("管理员联系信息");
    // 旧密钥入口必须消失
    expect(html).not.toContain("激活商业授权");
    expect(html).not.toContain("手动刷新授权");
    expect(html).not.toContain("gx-license-");
    // 未持有商业单据（本例 verdict=licensed，故不开通引导不显）——离线折叠默认收起
    expect(html).not.toContain("生成申请码");
  });

  it("免费档管理员：出现复制完整设备指纹的开通引导", () => {
    statusMock.mockReturnValue(
      status({
        isAdmin: true,
        verdict: "free",
        verdictLabel: "免费版",
        fingerprint: "a1b2c3d4e5f600112233445566778899aabbccdd",
      }),
    );
    const html = rts(<LicenseAdvanced />);
    expect(html).toContain("复制完整设备指纹");
  });
});

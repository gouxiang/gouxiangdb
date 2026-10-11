// UpdatePanel 五态渲染回归（node：react-dom/server + vi.mock，仓库 web 侧无 jsdom）。
// 覆盖 DESIGN §6.3：idle/checking/latest/available/error；available 内 eligible 分下载/联系支持；
// newerSchema 弱提示；版本不可解析弱提示；下载 pending 禁用文案；text 格式更新说明。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateStatusDTO, UpdateInfoDTO, CurrentIdentityDTO } from "@gx/shared-types";

type StatusReturn = {
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  data: UpdateStatusDTO | undefined;
  check: () => void;
};

let statusReturn: StatusReturn;
let downloadPending = false;
const checkSpy = vi.fn();
const mutateSpy = vi.fn();
const onUnregistered = vi.fn();

vi.mock("../../../api/client", () => ({
  // copyText 由 clipboard 入口 mock；这里仅需保证模块可导入。
  withBase: (p: string) => p,
}));

vi.mock("../update-hooks", () => ({
  useUpdateStatus: () => statusReturn,
  useUpdateDownload: () => ({
    mutate: mutateSpy,
    isPending: downloadPending,
    isError: false,
    error: null,
    isSuccess: false,
  }),
  isUpdateNotEnabled: (e: unknown) =>
    typeof e === "object" && e !== null && (e as { status?: number }).status === 404,
  describeUpdateError: (e: unknown) =>
    typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: string }).message)
      : "检查更新失败，请稍后重试",
}));

vi.mock("../../../lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

vi.mock("../../../components/ui", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    icon: _icon,
    variant: _v,
    size: _s,
    disabledReason: _r,
    block: _b,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    icon?: string;
    variant?: string;
    size?: string;
    disabledReason?: string;
    block?: boolean;
  }) => (
    <button
      type="button"
      data-loading={loading ? "1" : undefined}
      disabled={Boolean(disabled || loading)}
      onClick={onClick}
    >
      {children}
    </button>
  ),
  toast: vi.fn(),
}));

vi.mock("../../../components/MdContent", () => ({
  // 断言用：markdown 块原样包一层，标记 data-md。
  MdContent: ({ md }: { md: string }) => <div data-md="1">{md}</div>,
}));

import { UpdatePanel } from "../UpdatePanel";

function current(over: Partial<CurrentIdentityDTO> = {}): CurrentIdentityDTO {
  return {
    version: "0.2.2",
    versionUnparseable: false,
    channel: "fnos-fpk",
    arch: "x64",
    platform: "linux",
    ...over,
  };
}

function info(over: Partial<UpdateInfoDTO> = {}): UpdateInfoDTO {
  return {
    version: "0.2.3",
    publishedAt: "2026-10-12T03:00:00.000Z",
    releaseNotes: { format: "markdown", zh: "**修复**若干问题" },
    minVersion: null,
    eligible: true,
    ineligibleReason: null,
    artifact: {
      arch: "x64",
      platform: "linux",
      filename: "gouxiangdb-0.2.3-x86.fpk",
      sizeBytes: 62_586_880,
      sha256: "a".repeat(64),
    },
    manualInstallGuide: {
      kind: "fnos-upload",
      steps: ["步骤一", "步骤二"],
      preUpgradeNote: "升级前提示",
    },
    ...over,
  };
}

function makeStatus(over: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO {
  return {
    enabled: true,
    current: current(),
    update: null,
    checkedAt: "2026-10-12T04:00:00.000Z",
    newerSchema: false,
    ...over,
  };
}

function render(): string {
  return renderToStaticMarkup(<UpdatePanel onUnregistered={onUnregistered} />);
}

beforeEach(() => {
  checkSpy.mockClear();
  mutateSpy.mockClear();
  onUnregistered.mockClear();
  downloadPending = false;
  statusReturn = { isFetching: false, isError: false, error: null, data: undefined, check: checkSpy };
});

describe("UpdatePanel 五态", () => {
  it("idle：挂载即显示检查按钮与提示，不表现错误", () => {
    const html = render();
    expect(html).toContain("检查更新");
    expect(html).toContain("检查不会影响正在使用的服务");
    expect(html).toContain("尚未检查");
  });

  it("checking：按钮 loading 且文案为正在检查", () => {
    statusReturn = { ...statusReturn, isFetching: true };
    const html = render();
    expect(html).toContain("正在检查更新");
    expect(html).toContain('data-loading="1"');
  });

  it("latest：显示当前已是最新 + 版本/通道/架构 + 检查时间", () => {
    statusReturn = { ...statusReturn, data: makeStatus() };
    const html = render();
    expect(html).toContain("当前已是最新版本");
    expect(html).toContain("0.2.2");
    expect(html).toContain("飞牛 fpk 成品包");
    expect(html).toContain("linux / x64");
    expect(html).toContain("重新检查");
  });

  it("版本不可解析：环境区出现「版本标识异常」弱提示", () => {
    statusReturn = {
      ...statusReturn,
      data: makeStatus({ current: current({ version: "0.0.0-dev", versionUnparseable: true }) }),
    };
    const html = render();
    expect(html).toContain("版本标识异常");
  });

  it("available+eligible：新版本/更新说明 markdown/大小/sha/下载按钮文件名/安装指引", () => {
    statusReturn = { ...statusReturn, data: makeStatus({ update: info() }) };
    const html = render();
    expect(html).toContain("发现新版本");
    expect(html).toContain("0.2.3");
    expect(html).toContain('data-md="1"');
    expect(html).toContain("**修复**若干问题");
    expect(html).toContain("59.7 MiB");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("下载 gouxiangdb-0.2.3-x86.fpk");
    expect(html).toContain("手动安装指引");
    // eligible 时不得出现「联系支持」替换语
    expect(html).not.toContain("当前版本过旧，无法直接升级");
  });

  it("available+text 格式：更新说明按纯文本节点渲染（不套 markdown 容器）", () => {
    statusReturn = {
      ...statusReturn,
      data: makeStatus({ update: info({ releaseNotes: { format: "text", zh: "第一行\n第二行" } }) }),
    };
    const html = render();
    expect(html).not.toContain('data-md="1"');
    expect(html).toContain("第一行");
    expect(html).toContain("第二行");
  });

  it("below-min（eligible=false）：不提供下载/sha，改为联系支持文案", () => {
    statusReturn = {
      ...statusReturn,
      data: makeStatus({
        update: info({
          eligible: false,
          ineligibleReason: "below_min_version",
          minVersion: "0.3.0",
          artifact: null,
        }),
      }),
    };
    const html = render();
    expect(html).toContain("发现新版本");
    expect(html).toContain("0.2.3");
    expect(html).toContain("当前版本过旧，无法直接升级，请联系支持获取升级方案");
    expect(html).not.toContain("gouxiangdb-0.2.3-x86.fpk");
    expect(html).not.toContain("SHA-256 校验值");
  });

  it("下载准备中：按钮 loading，文案为正在准备下载", () => {
    downloadPending = true;
    statusReturn = { ...statusReturn, data: makeStatus({ update: info() }) };
    const html = render();
    expect(html).toContain("正在准备下载");
    expect(html).toContain('data-loading="1"');
  });

  it("error：显示错误中文文案与重试按钮", () => {
    statusReturn = {
      ...statusReturn,
      isFetching: false,
      isError: true,
      error: { message: "暂时无法连接更新服务，您可以稍后重试" },
      data: undefined,
    };
    const html = render();
    expect(html).toContain("暂时无法连接更新服务，您可以稍后重试");
    expect(html).toContain("重试");
  });

  it("newerSchema=true：显示清单版本弱提示", () => {
    statusReturn = { ...statusReturn, data: makeStatus({ newerSchema: true }) };
    const html = render();
    expect(html).toContain("更新清单版本较新");
  });

  it("unknown 通道：显示「未识别的部署方式」", () => {
    statusReturn = {
      ...statusReturn,
      data: makeStatus({ current: current({ channel: "unknown" }) }),
    };
    const html = render();
    expect(html).toContain("未识别的部署方式");
  });
});

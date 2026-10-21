// apps/web/src/features/sync/syncUi.test.ts
// bannerModel / reasonCodes / fieldCompare 纯函数 + 宿主/抽屉 SSR 默认空（无 jsdom）。
import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { bannerModel } from "./bannerModel";
import { reasonText, KNOWN_REASON_CODES, UNKNOWN_REASON_TEXT } from "./reasonCodes";
import { buildFieldRows, hasAnyDifference, displayValue } from "./fieldCompare";
import { ConflictResolverHost } from "./ConflictResolverHost";
import { SyncCenterHost, SyncCenterDrawer, SyncCenterPanel } from "./SyncCenterDrawer";
import type { SyncCenterPanelProps } from "./SyncCenterDrawer";
import { OfflineBanner } from "../../components/states";
import { useSyncStore } from "../../store/sync";
import { disabledSyncStatus, type LocalSyncStatus } from "../../api/localSync";

describe("bannerModel 六态", () => {
  it("未启用/在线/同步中 → null（零像素）", () => {
    expect(bannerModel(null)).toBeNull();
    expect(bannerModel("online")).toBeNull();
    expect(bannerModel("syncing")).toBeNull();
  });
  it("quarantined → danger 条跳隔离区", () => {
    const m = bannerModel("quarantined")!;
    expect(m.tone).toBe("danger");
    expect(m.tab).toBe("incoming");
  });
  it("error → warning；离线两态 → offline", () => {
    expect(bannerModel("error")!.tone).toBe("warning");
    expect(bannerModel("offlinePending")!.tab).toBe("status");
    const local = bannerModel("offlineLocalOnly")!;
    expect(local.tone).toBe("offline");
    expect(local.text).toContain("本机");
  });
});

describe("reasonText 全覆盖与兜底", () => {
  it("空码返空串", () => {
    expect(reasonText(null)).toBe("");
    expect(reasonText("")).toBe("");
  });
  it("关键码有中文映射", () => {
    expect(reasonText("SYNC_VERSION_CONFLICT")).toContain("冲突");
    expect(reasonText("SYNC_PERMISSION_REVOKED")).toContain("权限");
    expect(reasonText("SYNC_QUARANTINED")).toContain("隔离");
  });
  it("所有已登记码都映射到非空中文且不回退兜底", () => {
    for (const code of KNOWN_REASON_CODES) {
      const t = reasonText(code);
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toBe(UNKNOWN_REASON_TEXT);
    }
  });
  it("未知码走兜底、不崩", () => {
    expect(reasonText("SYNC_FUTURE_UNKNOWN")).toBe(UNKNOWN_REASON_TEXT);
  });
});

describe("fieldCompare 双栏", () => {
  it("displayValue 标量/对象/空值", () => {
    expect(displayValue("x")).toBe("x");
    expect(displayValue(null)).toBe("—");
    expect(displayValue(undefined)).toBe("—");
    expect(displayValue("")).toBe("—");
    expect(displayValue(3)).toBe("3");
    expect(displayValue({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });

  it("键并集 + changed/onlyIn 标记", () => {
    const rows = buildFieldRows({ a: 1, b: 2 }, { a: 9, c: 3 });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.a!.changed).toBe(true);
    expect(byKey.a!.onlyIn).toBeNull();
    expect(byKey.b!.onlyIn).toBe("mine");
    expect(byKey.b!.theirs).toBe("—");
    expect(byKey.c!.onlyIn).toBe("theirs");
    expect(hasAnyDifference(rows)).toBe(true);
  });

  it("无差异时 hasAnyDifference=false；theirs=null 全为占位", () => {
    const same = buildFieldRows({ a: 1 }, { a: 1 });
    expect(hasAnyDifference(same)).toBe(false);
    const noSnap = buildFieldRows({ a: 1 }, null);
    expect(noSnap[0]!.theirs).toBe("—");
    expect(noSnap[0]!.changed).toBe(true);
  });
});

describe("宿主 SSR 默认零渲染（门控/空态）", () => {
  beforeEach(() => {
    useSyncStore.getState().resetRuntime();
  });

  it("ConflictResolverHost 无冲突时为空", () => {
    expect(renderToStaticMarkup(<ConflictResolverHost />)).toBe("");
  });
  it("SyncCenterHost 未启用时为空（浏览器面零像素）", () => {
    expect(renderToStaticMarkup(<SyncCenterHost />)).toBe("");
  });
  it("SyncCenterDrawer 未打开时为空（容器门控，SSR 初始快照即关闭态）", () => {
    expect(renderToStaticMarkup(<SyncCenterDrawer />)).toBe("");
  });
  it("OfflineBanner 在 SSR/非壳默认在线 → 空串（逐字节回退旧二态、零像素）", () => {
    expect(renderToStaticMarkup(<OfflineBanner />)).toBe("");
  });
});

/**
 * 纯展示面板的 SSR 渲染入口：直接喂 props（zustand v5 的 SSR 快照恒为 getInitialState，
 * getState() 变更不会进入 renderToStaticMarkup，故容器的「打开后」内容只能经纯面板接缝验证）。
 */
function renderPanel(over: Partial<SyncCenterPanelProps> & {
  tab: SyncCenterPanelProps["tab"];
  online: boolean;
  report?: LocalSyncStatus;
}): string {
  const props: SyncCenterPanelProps = {
    tab: over.tab,
    online: over.online,
    report: over.report ?? { ...disabledSyncStatus(), enabled: true },
    phase: over.phase ?? null,
    conflicts: over.conflicts ?? [],
    lastFetchedAt: over.lastFetchedAt ?? null,
    incomingItems: over.incomingItems ?? null,
    incomingError: over.incomingError ?? null,
    closing: false,
    onSelectTab: over.onSelectTab ?? (() => {}),
    onClose: over.onClose ?? (() => {}),
    onIncomingChange: over.onIncomingChange ?? (() => {}),
  };
  return renderToStaticMarkup(<SyncCenterPanel {...props} />);
}

describe("SyncCenterDrawer 五分区（SSR 直渲染纯面板）", () => {
  it("status 分区含五个分区标签、标题与状态/节点字段", () => {
    const html = renderPanel({
      tab: "status",
      online: true,
      report: { ...disabledSyncStatus(), enabled: true, nodeId: "n1" },
    });
    expect(html).toContain("同步中心");
    for (const label of ["状态", "待发", "冲突", "隔离区", "占用"]) {
      expect(html).toContain(label);
    }
    // 默认 status 分区展示节点/时间字段
    expect(html).toContain("当前状态");
    expect(html).toContain("同步节点");
  });

  it("storage 分区只读展示占用（2048 字节 → 2 KB）", () => {
    const html = renderPanel({
      tab: "storage",
      online: true,
      report: { ...disabledSyncStatus(), enabled: true, localBytesUsed: 2048 },
    });
    expect(html).toContain("本地副本占用");
    expect(html).toContain("2 KB");
  });

  it("离线时隔离区只读提示、不拉明细（裁决联网后处理）", () => {
    const html = renderPanel({ tab: "incoming", online: false });
    expect(html).toContain("当前离线，隔离区为只读");
    expect(html).toContain("联网后处理冲突");
  });
});

describe("离线裁决置灰 + 502 就地提示（源码护栏）", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  it("ConflictResolverHost 读 store.online 置灰并含离线文案、502 判定", () => {
    const src = read("./ConflictResolverHost.tsx");
    expect(src).toContain("useSyncStore((s) => s.online)");
    expect(src).toContain("联网后处理冲突");
    expect(src).toContain("isSyncUpstreamError");
    // 绝不挂全局错误总线，只在本地 catch 就地提示。
    expect(src).not.toContain("apiFetch.onError");
  });
  it("SyncCenterDrawer 操作面走侧车代理并对 502 就地提示", () => {
    const src = read("./SyncCenterDrawer.tsx");
    expect(src).toContain("isSyncUpstreamError");
    expect(src).toContain("无法连接远端服务器");
  });
});

describe("UI 公约护栏（只准 gx-* 令牌 / 圆角 / 无新依赖）", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const files = [
    "./SyncCenterDrawer.tsx",
    "./ConflictResolverHost.tsx",
  ];
  for (const f of files) {
    it(`${f} 不使用禁用圆角令牌 rounded-gx-pill`, () => {
      expect(read(f)).not.toContain("rounded-gx-pill");
    });
  }
});


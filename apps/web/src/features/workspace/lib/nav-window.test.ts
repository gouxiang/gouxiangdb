// M3/S10 首屏 DOM 有界验证（纯算术层，不依赖 jsdom/DOM——web 零新依赖约束）。
//
// 度量口径声明（防止把数字当浏览器 P95）：
//  - 本文件数字全部来自 Node/vitest 下的纯函数算术（virtualWindow/flattenMenuRows/buildSecondaryRows），
//    证明「挂载行数 = 视口函数，与菜单总量无关」这一有界性，以及切片本身 O(窗口) 的耗时量级；
//  - 不是浏览器渲染 P95，也不是真实 DOM 节点数快照；真实滚动/ResizeObserver 行为走真机手测
//    （手测清单中给出 1000+ 夹具操作步骤），浏览器侧 P95 由真机 performance 面板留证。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MenuItemDTO, MenuNodeSummaryDTO } from "@gx/shared-types";
import { buildMenuTree, flattenMenuRows } from "./menu-tree";
import { virtualWindow } from "../../contacts/lib/tree";
import { buildSecondaryRows, SECONDARY_ROW_H, type SecondaryEntry } from "../SecondaryNavSections";

/** 一级行高（PrimaryNav.NAV_ROW_H，源码同名常量未导出，测试侧按同值锁定）。 */
const PRIMARY_ROW_H = 32;
const OVERSCAN = 12; // useMenuVirtualizer 默认 overscan
/** 典型侧栏可视高度（900p 屏去掉顶栏/底栏后的保守取值），仅用于上界算术。 */
const VIEWPORT_H = 768;

// ---------- 夹具（完整合法字段，过 tsc） ----------

function summary(id: string, kind: MenuNodeSummaryDTO["kind"] = "table"): MenuNodeSummaryDTO {
  return {
    id,
    kind,
    name: `n_${id}`,
    iconName: null,
    resourceType: kind,
    resourceId: `res_${id}`,
    state: "alive",
  };
}

function shortcut(id: string, nodeId: string, parentId: string | null, ord = 0): MenuItemDTO {
  return {
    id,
    parentId,
    type: "shortcut",
    nodeId,
    label: null,
    iconName: null,
    ord,
    node: summary(nodeId),
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
  };
}

function container(id: string, parentId: string | null = null, ord = 0): MenuItemDTO {
  return {
    id,
    parentId,
    type: "container",
    nodeId: null,
    label: id,
    iconName: null,
    ord,
    node: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
  };
}


// ---------- 有界性 ----------

describe("virtualWindow 切片：挂载行数只与视口相关（有界性）", () => {
  it("窗口大小 = ceil(vh/rowH) + 2*overscan，不随 total 增长（1000/10000/100000 同窗口）", () => {
    const bound = (rowH: number) => Math.ceil(VIEWPORT_H / rowH) + 2 * OVERSCAN;
    for (const total of [100, 1000, 10000, 100000]) {
      // 滚到中段，取最宽窗口
      const mid = Math.floor(total / 2) * SECONDARY_ROW_H;
      const win = virtualWindow(mid, VIEWPORT_H, SECONDARY_ROW_H, total, OVERSCAN);
      expect(win.end - win.start).toBeLessThanOrEqual(bound(SECONDARY_ROW_H));
      expect(win.padTop + win.padBottom + (win.end - win.start) * SECONDARY_ROW_H).toBe(
        total * SECONDARY_ROW_H,
      );
    }
    // 二级 31px、768px 视口：ceil(768/31)=25 可视 + 24 overscan = 最多 49 行
    expect(Math.ceil(VIEWPORT_H / SECONDARY_ROW_H) + 2 * OVERSCAN).toBe(49);
    // 一级 32px：24 可视 + 24 = 最多 48 行
    expect(Math.ceil(VIEWPORT_H / PRIMARY_ROW_H) + 2 * OVERSCAN).toBe(48);
  });

  it("首帧保守视口（rowH*24）下窗口即有界：一级/二级均 = 24+2*overscan 行", () => {
    // useMenuVirtualizer 首帧 viewportH = rowH*24，ResizeObserver 挂载前也不全量渲染
    const firstFrame = (rowH: number) => {
      const win = virtualWindow(0, rowH * 24, rowH, 99999, OVERSCAN);
      return win.end - win.start;
    };
    expect(firstFrame(PRIMARY_ROW_H)).toBe(24 + 2 * OVERSCAN);
    expect(firstFrame(SECONDARY_ROW_H)).toBe(24 + 2 * OVERSCAN);
    // 编排树（ComposerTree）已随导航编排下线删除，不再有 31px 行高档位需要锁。
  });

  it("滚动到真实底部（scrollTop ≤ totalHeight-vh，浏览器保证）时 end=total、padBottom=0", () => {
    const total = 1000;
    const maxScrollTop = total * SECONDARY_ROW_H - VIEWPORT_H;
    const win = virtualWindow(maxScrollTop, VIEWPORT_H, SECONDARY_ROW_H, total, OVERSCAN);
    expect(win.end).toBe(total);
    expect(win.start).toBeGreaterThan(900);
    expect(win.end - win.start).toBeLessThanOrEqual(49);
    expect(win.padBottom).toBe(0);
  });

  it("total=0 空列表窗口为空、无 pad（空态不产任何行）", () => {
    const win = virtualWindow(0, VIEWPORT_H, SECONDARY_ROW_H, 0, OVERSCAN);
    expect(win).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 });
  });
});

describe("PrimaryNav 扁平化 + 窗口：1000+ 容器折叠后 DOM 进一步收敛", () => {
  it("1000 项挂一个容器：全摊平 1001 行，但窗口最多 48 行；折叠容器后只剩 1 行", () => {
    const items: MenuItemDTO[] = [container("c")];
    for (let i = 0; i < 1000; i++) {
      items.push(shortcut(`s${i}`, `n${i}`, "c", i));
    }
    const tree = buildMenuTree(items);
    const flat = flattenMenuRows(tree, () => true);
    expect(flat).toHaveLength(1001);

    const win = virtualWindow(0, VIEWPORT_H, PRIMARY_ROW_H, flat.length, OVERSCAN);
    expect(win.end - win.start).toBeLessThanOrEqual(48);

    const collapsed = flattenMenuRows(tree, () => false);
    expect(collapsed.map((r) => r.node.item.id)).toEqual(["c"]);
  });
});

function entry(id: string, kind: SecondaryEntry["kind"], parentId: string | null = null): SecondaryEntry {
  return {
    id,
    name: `${kind}-${id}`,
    kind,
    parentId,
    href:
      kind === "table"
        ? `/base/base1/table/${id}`
        : kind === "canvas"
          ? `/kb/kb1/canvas/${id}`
          : `/kb/kb1/doc/${id}`,
    icon: null,
    iconColor: null,
  };
}

describe("buildSecondaryRows 三段合并单序列（SecondaryNav 单窗口输入）", () => {
  it("空段不产段头；段头计数 = 该段条目数；table/canvas depth 恒 0", () => {
    const sections = {
      table: Array.from({ length: 50 }, (_, i) => entry(`t${i}`, "table")),
      doc: [] as SecondaryEntry[],
      canvas: Array.from({ length: 3 }, (_, i) => entry(`cv${i}`, "canvas", "kb1")),
    };
    const rows = buildSecondaryRows(sections, new Set(), new Map());
    expect(
      rows.filter((r) => r.type === "header").map((r) => (r as { kind: string }).kind),
    ).toEqual(["table", "canvas"]);
    expect(rows[0]).toMatchObject({ type: "header", kind: "table", count: 50 });
    expect(rows.filter((r) => r.type === "entry")).toHaveLength(53);
  });

  it("doc 折叠只出根行；展开按 depth 递增摊平（S9 层级展开行为在窗口化后保持）", () => {
    const sections = {
      table: [] as SecondaryEntry[],
      canvas: [] as SecondaryEntry[],
      doc: [
        entry("d0", "doc", "kb1"),
        entry("d1", "doc", "d0"),
        entry("d2", "doc", "d1"),
      ],
    };
    const docChildren = new Map<string, SecondaryEntry[]>([
      ["d0", [sections.doc[1]!]],
      ["d1", [sections.doc[2]!]],
    ]);
    const collapsed = buildSecondaryRows(sections, new Set(), docChildren);
    const collapsedIds = collapsed
      .filter((r) => r.type === "entry")
      .map((r) => (r as { entry: SecondaryEntry }).entry.id);
    expect(collapsedIds).toEqual(["d0"]);

    const expanded = buildSecondaryRows(sections, new Set(["d0", "d1"]), docChildren);
    const entries = expanded.filter(
      (r) => r.type === "entry",
    ) as Extract<(typeof expanded)[number], { type: "entry" }>[];
    expect(entries.map((e) => [e.entry.id, e.depth])).toEqual([
      ["d0", 0],
      ["d1", 1],
      ["d2", 2],
    ]);
  });

  it("1000 条未收纳 table：总序列 1001 行（含段头），单窗口挂载 ≤ 49 行", () => {
    const sections = {
      table: Array.from({ length: 1000 }, (_, i) => entry(`t${i}`, "table")),
      doc: [] as SecondaryEntry[],
      canvas: [] as SecondaryEntry[],
    };
    const rows = buildSecondaryRows(sections, new Set(), new Map());
    expect(rows).toHaveLength(1001);
    const win = virtualWindow(400 * SECONDARY_ROW_H, VIEWPORT_H, SECONDARY_ROW_H, rows.length, OVERSCAN);
    expect(win.end - win.start).toBeLessThanOrEqual(49);
  });
});

describe("切片工作量（确定性计数，不依赖真实时钟）", () => {
  // 方法说明：不用 performance.now() 断言耗时——CI 抖动机上同一段算术能从 3ms 飘到 60ms+，
  // 阈值断言必然偶发红（flaky），且红/绿都不说明任何性能事实。改为**数工作量**：
  //   · flattenVisits = 摊平触达的菜单项数（O(total)，一次遍历，与窗口化无关）；
  //   · sliceVisits   = 真正进入渲染列表的行数（= 窗口大小，与 total 无关 → O(窗口)）。
  // 这两个数是算法属性，次数恒定，不受机器快慢/调度抖动影响。
  const measure = (n: number) => {
    const items: MenuItemDTO[] = [container("c")];
    for (let i = 0; i < n; i++) items.push(shortcut(`s${i}`, `n${i}`, "c", i));
    const flat = flattenMenuRows(buildMenuTree(items), () => true);
    const win = virtualWindow(0, VIEWPORT_H, PRIMARY_ROW_H, flat.length, OVERSCAN);
    const sliced = flat.slice(win.start, win.end);
    return {
      total: flat.length,
      flattenVisits: flat.length,
      sliceVisits: sliced.length,
      mounted: win.end - win.start,
    };
  };

  it("1000 与 10000 菜单：挂载行数恒定，切片工作量与总量无关", () => {
    const r1k = measure(1000);
    const r10k = measure(10000);
    console.log("[nav-window] 工作量计数（非耗时）", JSON.stringify({ r1k, r10k }));
    expect(r1k.total).toBe(1001);
    expect(r10k.total).toBe(10001);
    expect(r1k.mounted).toBe(r10k.mounted); // 总量 ×10，挂载行数不变
    // 切片只走窗口：万级与千级触达的行数完全相同（O(窗口)，不是 O(总量)）
    expect(r10k.sliceVisits).toBe(r1k.sliceVisits);
    expect(r10k.sliceVisits).toBeLessThanOrEqual(48);
    // 摊平仍是 O(总量) 的一次遍历（窗口化没有把它变成全量渲染，但也没让它免费）
    expect(r10k.flattenVisits).toBe(r10k.total);
    expect(r10k.flattenVisits).toBeGreaterThan(r10k.sliceVisits);
  });
});

describe("窗口化接线源码守卫（防回归：三处必须挂 scrollerRef 且渲染 windowed 切片）", () => {
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  const read = (p: string) => readFileSync(here(p), "utf8");

  it("PrimaryNav / SecondaryNav 均把 scrollerRef 挂到滚动容器并渲染 virt.windowed", () => {
    const primary = read("../PrimaryNav.tsx");
    expect(primary).toContain("ref={virt.scrollerRef}");
    expect(primary).toContain("virt.windowed.map");
    // v6 S1：L1 滚动容器的 overflow-y:auto 收敛到 index.css 的 .gx-rail-nav
    // （组件源码零 hex/视觉声明纪律），这里同锁两侧接线。
    expect(primary).toContain("gx-rail-nav");
    const css = read("../../../index.css");
    expect(css).toMatch(/\.gx-rail-nav[\s\S]*overflow-y:\s*auto/);

    // ComposerTree 源码守卫随组件删除（导航编排树零生产引用），不再需要锁其接线。

    const secondary = read("../SecondaryNav.tsx");
    expect(secondary).toContain("ref={virt.scrollerRef}");
    expect(secondary).toContain("virt.windowed.map");
    expect(secondary).toContain("overflow-y-auto");
  });

  it("useMenuVirtualizer 首帧 viewportH 为保守常量（非 0），ResizeObserver 与 passive scroll 接线齐全", () => {
    const src = read("./useMenuVirtualizer.ts");
    expect(src).toContain("rowH * 24");
    expect(src).toContain("new ResizeObserver");
    expect(src).toContain("{ passive: true }");
    // 复用 M2 通讯录同一纯函数，口径单一、零新依赖
    expect(src).toContain('from "../../contacts/lib/tree"');
  });
});

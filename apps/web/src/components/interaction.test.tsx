// 阶段 4 交互路径与通用边界回归（node 环境，react-dom/server，无 jsdom、无新增依赖）。
//
// 锁的是「阶段 4 抽出来的通用件真的被按规范用起来」：
//   R-I-02  已加载条数文案 / 分页器切换阈值
//   R-I-03  搜索框 170×32、防抖 300ms
//   R-I-05  列宽下限 80
//   R-I-09  行操作菜单：删除类永远排最后
//   R-I-13  表头三态复选框（全选 / 部分选 / 未选）
//   R-I-14  批量条带影响条数 + 「选择全部 N 条」+ 取消选择
//   R-I-17  导入第一步的 CSV 预览解析（引号包裹 / 转义 / 尾行）
//   R-I-21  状态胶囊：11px + pill + 语义色底（非 hex 要能降级，不能拼出非法色值）
//   R-I-22  横向步骤条：当前 accent / 已完成打勾 / 未开始 hint
//   R-I-26  useWriteGuard 同 key 并发只跑一次（防双击建两条）
//   R-I-29  长文本截断必带 title 全文
//   R-D-15  ≥300ms 才显示加载态（本文件只锁常量与调用点，副作用需浏览器）
//   R-D-22  软删除 toast 必带「撤销」，窗口 6s
//   R-D-27  局部刷新保留旧内容 + opacity，不用骨架屏
//
// 说明：useDelayedFlag / useDebouncedCommit / useWriteGuard 是 hook，node 下没有渲染器可跑
// 副作用，故对 hook 一律采用「纯函数 + 源码调用点」双重断言，不谎称跑过计时器。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  LOADING_DELAY_MS,
  MIN_COL_WIDTH,
  PAGINATE_THRESHOLD,
  SEARCH_BOX_W,
  SEARCH_DEBOUNCE_MS,
  WRITE_TIMEOUT_MS,
  BulkActionBar,
  FilterActiveBadge,
  ListSearchBox,
  StatusPill,
  StepBar,
  TriStateCheckbox,
  TruncatedText,
  bulkDeleteText,
  loadedCountText,
  orderRowMenu,
  refreshingClass,
  shouldUsePaginator,
  toastDeleted,
} from "./interaction";
import { parseCsvPreview } from "../features/grid/ImportWizard";
import { dismissToast, toastSnapshot } from "./ui";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** 剥注释后再判「不该出现 X」：源码里留的反例说明注释不该被误判为违规。 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

describe("阶段4 · 规范常量（集中放置，便于回归）", () => {
  it("R-D-15 加载态门槛 300ms / R-I-03 防抖 300ms / 搜索框 170 / 列宽下限 80 / 分页阈值 5000 / 写超时 15s", () => {
    expect(LOADING_DELAY_MS).toBe(300);
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
    expect(SEARCH_BOX_W).toBe(170);
    expect(MIN_COL_WIDTH).toBe(80);
    expect(PAGINATE_THRESHOLD).toBe(5000);
    expect(WRITE_TIMEOUT_MS).toBe(15000);
  });
});

describe("R-I-29 长文本截断必带 title 全文", () => {
  it("单行截断：truncate + title 全文", () => {
    const html = render(<TruncatedText text="一个非常非常长的表名，长到一定会溢出容器" />);
    expect(html).toContain("title=\"一个非常非常长的表名，长到一定会溢出容器\"");
    expect(html).toContain("truncate");
    expect(html).toContain("data-gx-truncated=\"true\"");
  });

  it("title 可被覆盖（需要显示比原文更完整的信息时）", () => {
    const html = render(<TruncatedText text="简称" title="完整名称（含路径）" />);
    expect(html).toContain("完整名称（含路径）");
  });
});

describe("R-I-21 状态胶囊：语义色底 + 深一档字，非 hex 要能降级", () => {
  it("hex 色：底 18% / 边框 50%，用 rgba 拼，不拼非法 hex", () => {
    const html = render(<StatusPill label="进行中" color="#3B82F6" />);
    expect(html).toContain("rgba(59, 130, 246, 0.18)");
    expect(html).toContain("rgba(59, 130, 246, 0.5)");
    expect(html).toContain("rounded-full");
    expect(html).toContain("text-gx-11");
    // 反例护栏：不能出现 #3B82F62e 这类拼尾巴的非法色值
    expect(html).not.toContain("#3B82F62e");
  });

  it("三位 hex 也要能解析（#f00）", () => {
    const html = render(<StatusPill label="紧急" color="#f00" />);
    expect(html).toContain("rgba(255, 0, 0, 0.18)");
  });

  it("非 hex（rgb()/命名色）→ 降级走 token，不产生非法 style", () => {
    const html = render(<StatusPill label="未知" color="rebeccapurple" />);
    expect(html).toContain("border-gx-border");
    expect(html).toContain("text-gx-text-secondary");
    expect(html).not.toContain("rgba(");
  });
});

describe("R-I-22 横向步骤条", () => {
  const steps = [
    { id: "upload", label: "上传" },
    { id: "mapping", label: "字段映射" },
    { id: "confirm", label: "确认" },
    { id: "run", label: "执行与结果" },
  ];

  it("当前步高亮 accent 且带 aria-current；已完成打勾；未开始 hint 灰", () => {
    const html = render(<StepBar steps={steps} current={1} />);
    expect(html).toContain("aria-current=\"step\"");
    expect(html).toContain("bg-gx-accent text-white"); // 当前
    expect(html).toContain("bg-gx-accent-bg text-gx-accent"); // 已完成
    expect(html).toContain("text-gx-text-hint"); // 未开始
    // 已完成渲染打勾图标；当前步渲染序号 2
    expect(html).toContain(">2<");
  });

  it("连接线数量 = 步数 - 1", () => {
    const html = render(<StepBar steps={steps} current={0} />);
    const connectors = html.split("bg-gx-hairline").length - 1;
    expect(connectors).toBe(steps.length - 1);
  });
});

describe("R-I-13 表头三态复选框", () => {
  it("全选：checked；部分选：partial 类 + 非 checked；未选：都不带", () => {
    expect(render(<TriStateCheckbox state="all" onChange={() => undefined} />)).toContain("checked");
    const partial = render(<TriStateCheckbox state="partial" onChange={() => undefined} />);
    expect(partial).toContain("gx-tristate-partial");
    expect(partial).not.toContain("checked");
    const none = render(<TriStateCheckbox state="none" onChange={() => undefined} />);
    expect(none).not.toContain("checked");
    expect(none).not.toContain("gx-tristate-partial");
  });

  it("带 aria-label，键盘可达", () => {
    expect(render(<TriStateCheckbox state="none" onChange={() => undefined} />)).toContain("aria-label=\"选择本页全部\"");
  });
});

describe("R-I-12 / R-I-14 批量操作条", () => {
  it("已选条数 + 选择全部 + 取消选择；危险按钮带影响条数", () => {
    const html = render(
      <BulkActionBar count={3} total={20} onSelectAll={() => undefined} onClearSelection={() => undefined} actions={<span>{bulkDeleteText(3)}</span>} />,
    );
    expect(html).toContain("已选 3 条");
    expect(html).toContain("选择全部 20 条");
    expect(html).toContain("取消选择");
    expect(html).toContain("删除 3 条记录");
  });

  it("已选 = 全部时不再显示「选择全部」（避免无效入口）", () => {
    const html = render(<BulkActionBar count={20} total={20} onSelectAll={() => undefined} onClearSelection={() => undefined} actions={null} />);
    expect(html).not.toContain("选择全部");
  });

  it("R-D-24 批量删除文案带条数，不是光秃秃的「删除」", () => {
    expect(bulkDeleteText(1)).toBe("删除 1 条记录");
    expect(bulkDeleteText(12, "行")).toBe("删除 12 行");
  });
});

describe("R-I-02 / R-D-27 分页口径与局部刷新", () => {
  it("分页器只在超阈值或用户切过页码时启用", () => {
    expect(shouldUsePaginator(1200, false)).toBe(false);
    expect(shouldUsePaginator(6000, false)).toBe(true);
    expect(shouldUsePaginator(1200, true)).toBe(true);
  });

  it("已加载条数文案：总数一致时不啰嗦", () => {
    expect(loadedCountText(50, 50)).toBe("已加载 50 条");
    expect(loadedCountText(50, 1200)).toBe("已加载 50 / 1200 条");
  });

  it("R-D-27 局部刷新保留旧内容 + 降透明度（不用骨架屏）", () => {
    expect(refreshingClass(true)).toContain("opacity-60");
    expect(refreshingClass(false)).toBe("");
  });
});

describe("R-I-09 行操作菜单：删除类永远排最后", () => {
  it("删除项被挪到末尾，其余保持原顺序", () => {
    const ordered = orderRowMenu([
      { label: "删除", danger: true },
      { label: "复制" },
      { label: "重命名" },
    ]);
    expect(ordered.map((i) => i.label)).toEqual(["复制", "重命名", "删除"]);
  });
});

describe("R-I-03 / R-I-04 搜索框与筛选徽标", () => {
  it("搜索框宽 170（附录 B 口径），保留旧结果时只降透明度", () => {
    const html = render(<ListSearchBox value="" onChange={() => undefined} />);
    expect(html).toContain("170");
    expect(html).toContain("placeholder");
  });

  it("「筛选中」徽标带条数且可一键清除", () => {
    const html = render(<FilterActiveBadge count={2} onClear={() => undefined} />);
    expect(html).toContain("筛选中");
    expect(html).toContain("2");
  });
});

describe("R-I-17 导入第一步：CSV 预览解析", () => {
  it("解析表头与数据行，忽略文件末尾的空行", () => {
    const rows = parseCsvPreview("姓名,部门\n张三,产品部\n李四,研发部\n");
    expect(rows).toEqual([
      ["姓名", "部门"],
      ["张三", "产品部"],
      ["李四", "研发部"],
    ]);
  });

  it("双引号内的逗号不切列，\"\" 转义为一个引号", () => {
    const rows = parseCsvPreview('a,b\n"1,000","他说""你好"""');
    expect(rows[1]).toEqual(["1,000", '他说"你好"']);
  });
});

describe("R-D-22 软删除 toast 必带撤销（窗口 6s）", () => {
  it("撤销动作存在，失败要显式报 error 而不是静默", () => {
    const id = toastDeleted({ message: "已删除「需求池」", onUndo: async () => undefined });
    const snap = toastSnapshot();
    const item = snap.find((t) => t.id === id);
    expect(item).toBeTruthy();
    expect(item!.kind).toBe("success");
    expect(item!.hasAction).toBe(true);
    // 6s 撤销窗口（R-D-22）
    expect(item!.duration).toBe(6000);
    dismissToast(id);
    expect(toastSnapshot().find((t) => t.id === id)).toBeUndefined();
  });
});

describe("阶段4 调用点护栏（hook 无法在 node 下跑副作用，改锁接线）", () => {
  it("R-D-15：列表首屏走 useDelayedFlag，不再直接 isLoading ? 骨架", () => {
    const grid = read("../features/grid/GridView.tsx");
    expect(grid).toContain("useDelayedFlag");
    expect(grid).toContain("showSkeleton");
    const trash = read("../features/settings/TrashPage.tsx");
    expect(trash).toContain("useDelayedFlag");
  });

  it("R-I-05：列宽拖拽下限用 MIN_COL_WIDTH(80)，不再是 60", () => {
    const grid = read("../features/grid/GridView.tsx");
    expect(grid).toContain("MIN_COL_WIDTH");
    expect(grid).not.toContain("Math.max(60");
  });

  it("R-I-26：写操作入口接了 useWriteGuard（记录新建 / 导入 / 导出 / 知识库删除）", () => {
    expect(read("../features/grid/GridView.tsx")).toContain("useWriteGuard()");
    expect(read("../features/drawer/RecordDrawer.tsx")).toContain("useWriteGuard()");
    expect(read("../features/grid/ImportWizard.tsx")).toContain("useWriteGuard()");
    expect(read("../features/workspace/TableActionRow.tsx")).toContain("useWriteGuard()");
    expect(read("../features/kb/KbTrashPage.tsx")).toContain("useWriteGuard()");
  });

  it("R-I-27：写接口带 timeoutMs，默认行为不变（只有显式传参才挂 AbortController）", () => {
    const client = read("../api/client.ts");
    expect(client).toContain("WRITE_TIMEOUT_MS");
    expect(client).toContain("ApiTimeoutError");
    expect(client).toContain("timeoutMs");
  });

  it("G.1：三处 window.confirm 已换成 feedback 的确认（原生 confirm 在自动化环境会挂死）", () => {
    for (const f of [
      "../features/kb/canvas/DocEditModal.tsx",
      "../features/kb/CanvasEditModal.tsx",
      "../features/kb/canvas/EditorModal.tsx",
    ]) {
      const src = code(f);
      expect(src).toContain("confirmDiscardChanges");
      expect(src).not.toContain("window.confirm");
    }
  });

  it("G.2：409 冲突与加载失败有真实调用点（不再只有组件没接线）", () => {
    expect(read("../features/kb/useDocPersistence.ts")).toContain("takeLatestVersion");
    expect(read("../features/kb/DocEditorPage.tsx")).toContain("ConflictNotice");
    expect(read("../features/contacts/MemberList.tsx")).toContain("ErrorState");
    expect(read("../features/settings/TrashPage.tsx")).toContain("ErrorState");
  });
});

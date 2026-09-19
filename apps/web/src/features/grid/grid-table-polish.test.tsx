// 数据表区域精细化回归（node 环境，react-dom/server + 源码断言，无 jsdom、无新增依赖）。
//
// 锁的是「参考图 · 方案A 数据表主界面」的实测基准，逐条对应改动点：
//   ① 行高与表头高：紧凑 36 / 常规 44 / 宽松 64（三档保留），表头固定 36
//   ② 单元格水平内边距统一 12px（px-3），全列一致
//   ③ 对齐：文本左、数值/工时/金额右，表头与数据列**逐列同侧**
//   ④ 表头：gx-surface-alt 底 / 12px / 中性弱色 / 无列间竖线 / 与数据区发丝线分隔
//   ⑤ 行间发丝线 gx-hairline；hover gx-row-hover；选中 gx-accent-bg（选中不被 hover 覆盖）
//   ⑥ 状态列走 StatusPill（同色 18% 底 + 语义色压暗字）；优先级列是纯文字带色，不是胶囊
//   ⑦ 空值统一弱色「—」，不显示空白也不显示 raw 值
//   ⑧ 首列（主键）文本比其余列重一档（font-medium）
//
// 断言口径：能 SSR 的一律真渲染后断言 DOM；只有「样式常量/调用点」这类无法从 DOM 反推的
// 才退回源码断言，并对每条源码断言注明原因。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { FieldDTO, PermissionSet, RecordDTO } from "@gx/shared-types";
import { ROW_HEIGHT_PX, HEADER_HEIGHT_PX } from "@gx/shared-types";
import { CellRenderer } from "../cells/CellRenderer";
import { cellTextAlign, isPriorityField, priorityTextClass, EMPTY_CELL_TEXT } from "../cells/format";
import { GridHeaderCell } from "./GridHeaderCell";
import { GridRow } from "./GridRow";
import { StatusPill } from "../../components/interaction";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const countOf = (s: string, needle: string) => s.split(needle).length - 1;

const field = (id: string, name: string, type: string, options?: unknown): FieldDTO =>
  ({ id, name, type, options: options ?? null, order: 0 }) as unknown as FieldDTO;

const select = (id: string, name: string, opts: { id: string; name: string; color: string }[]) =>
  field(id, name, "singleSelect", opts);

const permissions: PermissionSet = {
  canManageBase: true,
  canManageSchema: true,
  canEditData: true,
  canComment: true,
  canView: true,
};

const noop = () => undefined;

/** 从 SSR 出的 style 里取出 color:rgb(r, g, b) 三元组 */
function textColorOf(html: string): [number, number, number] | null {
  const m = html.match(/color:rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function renderCell(f: FieldDTO, value: unknown, emphasis = false) {
  return render(<CellRenderer value={value as never} field={f} permissions={permissions} emphasis={emphasis} />);
}

function renderHeader(f: FieldDTO, stickyLeft?: number) {
  return render(
    <GridHeaderCell
      field={f}
      width={160}
      canManageSchema
      onSort={noop}
      onHide={noop}
      onResize={noop}
      stickyLeft={stickyLeft}
    />,
  );
}

function renderRow(over: { fields?: FieldDTO[]; values?: Record<string, unknown>; selected?: boolean } = {}) {
  const fields = over.fields ?? [field("f1", "任务名称", "singleLineText"), field("f2", "预估工时", "duration")];
  const record = { id: "r1", tableId: "t1", fields: over.values ?? { f1: "登录页改版", f2: 16 } } as unknown as RecordDTO;
  return render(
    <GridRow
      record={record}
      fields={fields}
      widthOf={(f) => (f.id === "f1" ? 240 : 120)}
      rowHeight={ROW_HEIGHT_PX.medium}
      selected={over.selected ?? false}
      activeFieldId={null}
      editing={null}
      permissions={permissions}
      rowHeaderWidth={56}
      primaryFieldId="f1"
      canEditData
      onToggleRowSelect={noop}
      onOpenRecord={noop}
      onCellClick={noop}
      onCellDoubleClick={noop}
      onCellKeyDown={noop as never}
      onStartEdit={noop}
      onCommitEdit={noop}
      onCancelEdit={noop}
    />,
  );
}

describe("① 行高与表头高（参考图实测：行 44 / 表头 36 / 紧凑 36）", () => {
  it("三档行高保留，紧凑 36 / 常规 44 / 宽松 64", () => {
    expect(ROW_HEIGHT_PX.short).toBe(36);
    expect(ROW_HEIGHT_PX.medium).toBe(44);
    expect(ROW_HEIGHT_PX.tall).toBe(64);
    expect(HEADER_HEIGHT_PX).toBe(36);
  });

  it("数据行渲染高度 = 传入档位（44），表头渲染高度 = 36", () => {
    expect(renderRow()).toContain("height:44px");
    expect(renderHeader(field("f1", "任务名称", "singleLineText"))).toContain("height:36px");
  });
});

describe("② 单元格水平内边距统一 12px（px-3），全列一致", () => {
  it("文本列 / 数值列 / 表头都是 px-3（12px），不再混用 px-2.5 / px-2", () => {
    for (const f of [field("f1", "任务名称", "singleLineText"), field("f2", "预估工时", "duration")]) {
      expect(renderCell(f, "x")).toContain("px-3");
      expect(renderHeader(f)).toContain("px-3");
    }
    // 反例护栏：单元格容器不再出现旧的 10px 内边距
    expect(read("../cells/CellRenderer.tsx")).not.toContain("px-2.5");
  });
});

describe("③ 对齐：文本左、数值/工时/金额右，表头与数据列逐列同侧", () => {
  it("数值型字段类型默认右对齐（含参考图「预估工时」duration）", () => {
    for (const t of ["number", "currency", "percent", "duration", "count", "rollup", "autoNumber"]) {
      expect(cellTextAlign(field("f", "x", t))).toBe("right");
    }
    for (const t of ["singleLineText", "longText", "date", "singleSelect", "checkbox", "links"]) {
      expect(cellTextAlign(field("f", "x", t))).toBe("left");
    }
  });

  it("工时列：单元格与表头**同为**右对齐（justify-end + text-right + tabular-nums / text-right）", () => {
    const dur = field("f2", "预估工时", "duration");
    expect(renderCell(dur, 16)).toContain("justify-end text-right tabular-nums");
    expect(renderHeader(dur)).toContain("text-right");
    const txt = field("f1", "任务名称", "singleLineText");
    expect(renderCell(txt, "登录页改版")).toContain("justify-start text-left");
    expect(renderHeader(txt)).toContain("text-left");
  });

  it("表头对齐不是写死的 text-left：走与单元格同一个 cellTextAlign", () => {
    const src = read("./GridHeaderCell.tsx");
    expect(src).toContain('import { cellTextAlign } from "../cells/format"');
    expect(src).toContain('cellTextAlign(field) === "right"');
  });
});

describe("④ 表头样式：gx-surface-alt 底 / 12px / 中性弱色 / 无列间竖线 / 发丝线分隔", () => {
  it("底 gx-table-header(#F9FAFC) + 12px + 弱色(gx-text-tertiary #5B6785) + 发丝线", () => {
    const html = renderHeader(field("f1", "任务名称", "singleLineText"));
    expect(html).toContain("bg-gx-table-header");
    expect(html).toContain("text-gx-12");
    expect(html).toContain("text-gx-text-tertiary");
    expect(html).toContain("border-b border-gx-hairline");
  });

  it("普通列之间不画竖线；只有冻结列（主字段）保留右侧发丝线", () => {
    const plain = renderHeader(field("f2", "预估工时", "duration"));
    expect(plain).not.toContain("border-r");
    const frozen = renderHeader(field("f1", "任务名称", "singleLineText"), 56);
    expect(frozen).toContain("border-r border-gx-hairline");
  });

  it("表头字重不超过 500（无粗体，font-medium 而非 font-semibold/bold）", () => {
    const html = renderHeader(field("f1", "任务名称", "singleLineText"));
    expect(html).toContain("font-medium");
    expect(html).not.toContain("font-semibold");
    expect(html).not.toContain("font-bold");
  });
});

describe("⑤ 行间发丝线 / hover / 选中（选中不被 hover 覆盖）", () => {
  it("数据行用 gx-hairline 发丝线，且不再出现旧的 gx-separator 竖线", () => {
    const html = renderRow();
    expect(html).toContain("border-b border-gx-hairline");
    expect(html).not.toContain("border-gx-separator");
    // 两列数据行：竖线只出现在行首固定列 + 冻结主字段列，共 2 处
    expect(countOf(html, "border-r")).toBe(2);
  });

  it("未选中行 hover 走 gx-row-hover；选中行恒为 gx-accent-bg 且不带 hover 覆盖", () => {
    expect(renderRow({ selected: false })).toContain("hover:bg-gx-row-hover");
    const sel = renderRow({ selected: true });
    expect(sel).toContain("bg-gx-accent-bg");
    expect(sel).not.toContain("hover:bg-gx-row-hover");
  });

  it("固定列（行首复选框列 / 冻结主字段列）用 bg-inherit：hover 与选中覆盖整行，不出现白缺口", () => {
    const html = renderRow();
    // 行首固定列 + 冻结主字段列 = 2 处，都不再各自写 bg-gx-surface（否则 hover/选中在这两列失效）
    expect(countOf(html, "bg-inherit")).toBe(2);
    // 全行只剩 <tr> 上的那一个底色类（白底），固定列不再各自写 bg-gx-surface
    expect(countOf(html, "bg-gx-surface")).toBe(1);
    expect(html).not.toContain("border-gx-hairline bg-gx-surface");
  });

  it("数据行不叠斑马纹（参考图白底 + 行间发丝线），zebra 档位仍保留可回退", () => {
    const html = renderRow();
    expect(html).not.toContain("bg-gx-zebra");
    const src = read("./GridView.tsx");
    expect(src).not.toContain("zebra={");
    expect(read("./GridRow.tsx")).toContain("zebra?: boolean");
  });
});

describe("⑥ 状态列 StatusPill / 优先级列纯文字带色", () => {
  const STATUS_OPTS = [
    { id: "s1", name: "进行中", color: "#3B82F6" },
    { id: "s2", name: "待评审", color: "#BA7517" },
    { id: "s3", name: "已完成", color: "#1D9E75" },
    { id: "s4", name: "待开始", color: "#8A94AC" },
  ];

  it("四态：底为同色 18%（rgba），文字为同色压暗一档（每通道不高于原色且整体更暗）", () => {
    for (const o of STATUS_OPTS) {
      const html = render(<StatusPill label={o.name} color={o.color} />);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(o.color.slice(i, i + 2), 16)) as [number, number, number];
      expect(html).toContain(`rgba(${r}, ${g}, ${b}, 0.18)`);
      expect(html).toContain(`rgba(${r}, ${g}, ${b}, 0.5)`);
      const c = textColorOf(html);
      expect(c).not.toBeNull();
      const dark = c as [number, number, number];
      expect(dark[0]).toBeLessThanOrEqual(r);
      expect(dark[1]).toBeLessThanOrEqual(g);
      expect(dark[2]).toBeLessThanOrEqual(b);
      expect(dark[0] + dark[1] + dark[2]).toBeLessThan(r + g + b);
    }
  });

  it("非 hex（rgb()/命名色）仍降级走 gx-* token，不拼非法色值", () => {
    const html = render(<StatusPill label="未知" color="rebeccapurple" />);
    expect(html).toContain("border-gx-border");
    expect(html).toContain("text-gx-text-secondary");
    expect(html).not.toContain("rgba(");
  });

  it("状态列渲染成胶囊（data-gx-status-pill）", () => {
    const html = renderCell(select("f3", "状态", STATUS_OPTS), "进行中");
    expect(html).toContain("data-gx-status-pill");
    expect(html).toContain("rgba(59, 130, 246, 0.18)");
  });

  it("优先级列是**纯文字带色**（高红 / 中橙 / 低灰），不是胶囊", () => {
    const prio = select("f4", "优先级", [
      { id: "p1", name: "高", color: "#E24B4A" },
      { id: "p2", name: "中", color: "#BA7517" },
      { id: "p3", name: "低", color: "#8A94AC" },
    ]);
    expect(isPriorityField(prio)).toBe(true);
    const high = renderCell(prio, "高");
    expect(high).toContain("text-gx-danger");
    expect(high).not.toContain("data-gx-status-pill");
    expect(renderCell(prio, "中")).toContain("text-gx-warning");
    expect(renderCell(prio, "低")).toContain("text-gx-text-hint");
    // 状态列不能误判成优先级
    expect(isPriorityField(select("f3", "状态", STATUS_OPTS))).toBe(false);
    // 未命中词表时不强行上色
    expect(priorityTextClass("其它")).toBe("text-gx-text-primary");
  });
});

describe("⑦ 空值统一弱色占位「—」", () => {
  it("文本 / 数值 / 日期 / 选择 等空值都渲染弱色「—」，不显示空白也不显示 raw 值", () => {
    expect(EMPTY_CELL_TEXT).toBe("—");
    for (const t of ["singleLineText", "number", "duration", "date", "singleSelect", "url"]) {
      const html = renderCell(field("f", "x", t), null);
      expect(html).toContain("—");
      expect(html).toContain("text-gx-text-hint");
    }
    // 反例护栏：空值不再渲染成空容器
    expect(renderCell(field("f", "x", "number"), null)).not.toContain("<div class=\"flex h-full w-full items-center gap-1 px-3 py-1 text-gx-13 justify-end text-right tabular-nums text-gx-text-primary\"></div>");
  });
});

describe("⑧ 首列（主键）文本比其余列重一档", () => {
  it("主键列单元格带 font-medium，其余列不带", () => {
    const html = renderRow();
    expect(countOf(html, "font-medium")).toBe(1);
  });
});

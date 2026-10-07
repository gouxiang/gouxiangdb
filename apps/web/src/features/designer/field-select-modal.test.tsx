// apps/web/src/features/designer/field-select-modal.test.tsx
// #691 / #693 回归：子表格字段选择弹窗 + 选项颜色手动入口。
// 运行环境为 node（仓库无 jsdom / @testing-library），按仓库既有三模式锁定：
//   ① 纯函数单测：defaultFieldIds / filterFields / orderedSelectedIds / optionTone
//   ② react-dom/server SSR 渲染 + HTML 字符串断言（createPortal 就地渲染）
//   ③ readFileSync 源码断言：批量确认/恢复默认/ColorPicker 接线与 addOption 默认色
//
// 弹窗交互的真实点击（搜索输入、勾选、确定）依赖浏览器 e2e，本文件用
// 「纯逻辑 + SSR 结构 + 源码接线」三层把行为锁死，不新增依赖。

import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString as rtsRaw } from "react-dom/server";
import type { ReactElement } from "react";
import type { FieldDTO, FieldIdT, TableIdT } from "@gx/shared-types";
import { FIELD_TYPE_LABEL } from "@gx/shared-types";

// 弹窗/气泡用 createPortal(..., document.body)；SSR 不支持 portal，
// 就地渲染 children 以便断言；生产代码不变。
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (children: unknown) => children };
});

beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  g.document = g.document ?? { body: {} };
});

import FieldSelectModal, {
  FieldSelectSummary,
  OptionColorButton,
  OPTION_DEFAULT_COLOR,
  defaultFieldIds,
  filterFields,
  orderedSelectedIds,
} from "./FieldSelectModal";
import { optionTone, parseHexColor, StatusPill } from "../../components/interaction";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

function render(node: ReactElement): string {
  return rtsRaw(node).replace(/<!--[^>]*-->/g, "");
}

let seq = 0;
function mkField(name: string, type: FieldDTO["type"] = "singleLineText"): FieldDTO {
  seq += 1;
  return {
    id: `f${seq}` as FieldIdT,
    tableId: "t1" as TableIdT,
    name,
    type,
    description: "",
    order: seq,
    required: false,
    unique: false,
    options: null,
    precision: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    recordFilter: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
  };
}

// ============================================================
// #691 · 纯函数
// ============================================================

describe("#691 defaultFieldIds：默认字段集（前 4 个）", () => {
  it("取前 4 个字段 id，顺序不变", () => {
    const fs = [1, 2, 3, 4, 5, 6].map((n) => mkField(`字段${n}`));
    expect(defaultFieldIds(fs)).toEqual(fs.slice(0, 4).map((f) => f.id));
  });
  it("不足 4 个时返回全部；空表返回空数组（不抛错）", () => {
    const two = [mkField("a"), mkField("b")];
    expect(defaultFieldIds(two)).toEqual(two.map((f) => f.id));
    expect(defaultFieldIds([])).toEqual([]);
  });
});

describe("#691 filterFields：搜索实时过滤", () => {
  const fs = [mkField("客户名称"), mkField("客户等级"), mkField("订单编号"), mkField("Phone")];
  it("空查询（含纯空格）返回全部，且是新数组不污染原数组", () => {
    expect(filterFields(fs, "").map((f) => f.name)).toHaveLength(4);
    expect(filterFields(fs, "   ")).not.toBe(fs);
  });
  it("大小写不敏感、按字段名包含匹配", () => {
    expect(filterFields(fs, "客户").map((f) => f.name)).toEqual(["客户名称", "客户等级"]);
    expect(filterFields(fs, "phone").map((f) => f.name)).toEqual(["Phone"]);
    expect(filterFields(fs, " 订单 ").map((f) => f.name)).toEqual(["订单编号"]);
  });
  it("无匹配返回空数组", () => {
    expect(filterFields(fs, "不存在")).toEqual([]);
  });
});

describe("#691 orderedSelectedIds：确定写回按候选字段顺序", () => {
  const fs = [mkField("a"), mkField("b"), mkField("c")];
  const [id0, id1, id2] = fs.map((f) => f.id as string);
  it("按 fields 顺序输出已选 id（与 Set 迭代序无关）", () => {
    expect(orderedSelectedIds(fs, new Set([id0, id1, id2]))).toEqual([id0, id1, id2]);
    expect(orderedSelectedIds(fs, new Set([id2, id0]))).toEqual([id0, id2]);
  });
  it("未选/选了不在候选里的 id → 空数组", () => {
    expect(orderedSelectedIds(fs, new Set())).toEqual([]);
    expect(orderedSelectedIds(fs, new Set(["zzz"]))).toEqual([]);
  });
});

// ============================================================
// #691 · SSR 结构
// ============================================================

describe("#691 FieldSelectModal · 默认态（value=null）", () => {
  const fs = [
    mkField("名称", "singleLineText"),
    mkField("等级", "number"),
    mkField("生日", "date"),
    mkField("分类", "singleSelect"),
    mkField("负责人", "links"),
    mkField("启用", "checkbox"),
  ];
  const noop = () => undefined;
  let html = "";
  beforeAll(() => {
    html = render(
      <FieldSelectModal
        fields={fs}
        value={null}
        onChange={noop}
        onClose={noop}
        title="选择子表格显示字段"
        subtitle="客户表"
      />,
    );
  });

  it("dialog 语义 + 尺寸规格 + 头部标题/对面表副标题", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("w-[560px]");
    expect(html).toContain("max-w-[92vw]");
    expect(html).toContain("max-h-[80vh]");
    expect(html).toContain("选择子表格显示字段");
    expect(html).toContain("来自数据表：客户表");
  });

  it("默认态横幅 + 默认集（前4个）预勾选，第5/6个不勾", () => {
    expect(html).toContain("当前为默认选择，勾选并确定后将变为自定义");
    expect(html).toContain("已选 4 项");
    // 每行用 aria-pressed 表达勾选态
    const pressed = html.match(/aria-pressed="true"/g) ?? [];
    expect(pressed).toHaveLength(4);
    const unpressed = html.match(/aria-pressed="false"/g) ?? [];
    expect(unpressed).toHaveLength(2);
  });

  it("列表含字段名与字段类型标签；搜索框存在", () => {
    for (const f of fs) expect(html).toContain(f.name);
    expect(html).toContain(FIELD_TYPE_LABEL.singleLineText);
    expect(html).toContain(FIELD_TYPE_LABEL.date);
    expect(html).toContain('aria-label="搜索字段名"');
  });

  it("底部含「恢复默认 / 取消 / 确定」", () => {
    expect(html).toContain("恢复默认");
    expect(html).toContain("取消");
    expect(html).toContain("确定");
  });
});

describe("#691 FieldSelectModal · 自定义态（value=显式数组）", () => {
  const fs = [mkField("a"), mkField("b"), mkField("c")];
  let html = "";
  beforeAll(() => {
    html = render(
      <FieldSelectModal
        fields={fs}
        value={[fs[0]!.id as string]}
        onChange={() => undefined}
        onClose={() => undefined}
        title="选择弹窗可见字段"
        subtitle="订单表"
      />,
    );
  });
  it("不显默认横幅，已选计数为 1，仅对应行勾选", () => {
    expect(html).not.toContain("当前为默认选择");
    expect(html).toContain("已选 1 项");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
  });
});

describe("#691 FieldSelectModal · 空候选", () => {
  let html = "";
  beforeAll(() => {
    html = render(
      <FieldSelectModal
        fields={[]}
        value={null}
        onChange={() => undefined}
        onClose={() => undefined}
        title="选择字段"
        subtitle="空表"
      />,
    );
  });
  it("空查询显「没有可选字段」，已选 0 项", () => {
    expect(html).toContain("没有可选字段");
    expect(html).toContain("已选 0 项");
  });
});

describe("#691 FieldSelectSummary · 摘要行", () => {
  const fs = [mkField("客户名"), mkField("客户等级"), mkField("客户编号")];
  it("空 ids（默认态）显「默认」", () => {
    const html = render(<FieldSelectSummary fields={fs} ids={[]} onSelect={() => undefined} />);
    expect(html).toContain("默认");
    expect(html).not.toContain("已选");
  });
  it("有值显「已选 N 项」+ 前 2 个字段名，超出 2 个带「等」", () => {
    const twoFields = fs.slice(0, 2);
    const two = render(
      <FieldSelectSummary fields={twoFields} ids={twoFields.map((f) => f.id as string)} onSelect={() => undefined} />,
    );
    expect(two).toContain("已选 2 项");
    expect(two).toContain("客户名、客户等级");
    expect(two).not.toContain(" 等");

    const three = render(
      <FieldSelectSummary fields={fs} ids={fs.map((f) => f.id as string)} onSelect={() => undefined} />,
    );
    expect(three).toContain("客户名、客户等级 等");
  });
  it("「选择」按钮在无候选字段时禁用", () => {
    const html = render(<FieldSelectSummary fields={[]} ids={[]} onSelect={() => undefined} />);
    expect(html).toContain('disabled=""');
  });
});

// ============================================================
// #691 · 源码接线：临时勾选/取消放弃/确定写回/恢复默认
// ============================================================

describe("#691 源码接线 · 快照临时态 + 批量确认", () => {
  const src = read("./FieldSelectModal.tsx");
  const start = src.indexOf("function FieldSelectModal(");
  const end = src.indexOf("export default FieldSelectModal");
  const body = src.slice(start, end);

  it("勾选只改临时 checked（toggle），不直接调 onChange", () => {
    expect(body).toContain("const toggle = (id: string) =>");
    expect(body).toContain("setChecked");
  });

  it("onChange 全组件仅 2 处调用：确定(orderedSelectedIds) 与 恢复默认(null)", () => {
    // 去掉注释干扰
    const code = body.replace(/\/\/[^\n]*/g, "");
    const calls = code.match(/onChange\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(body).toContain("onChange(orderedSelectedIds(fields, checked))");
    expect(body).toContain("onChange(null)");
  });

  it("确定后 onClose；取消/遮罩/Esc 走 onClose 且不写回", () => {
    expect(body).toContain('onClick={onClose}');
    expect(body).toContain('if (e.key === "Escape") onClose()');
  });

  it("默认态判定 value===null，并按 defaultFieldIds 预勾选", () => {
    expect(body).toContain("value === null ? defaultFieldIds(fields) : value");
  });

  it("不再引入 kb.css（ColorPicker 不依赖它，弹窗只用 gx token）", () => {
    expect(src).not.toContain('import "../kb/kb.css"');
    expect(src).not.toMatch(/kb\.css/);
  });
});

// ============================================================
// #693 · optionTone / parseHexColor 统一混色
// ============================================================

describe("#693 统一混色口径", () => {
  it("parseHexColor 已从 interaction 导出，支持 6 位与 3 位 hex", () => {
    expect(parseHexColor("#3b82f6")).toEqual([59, 130, 246]);
    expect(parseHexColor("#abc")).toEqual([170, 187, 204]);
    expect(parseHexColor("rgb(1,2,3)")).toBeNull();
  });

  it("optionTone：18% 浅底 + 50% 同系边框 + darkenForText 深字", () => {
    const t = optionTone("#3B82F6");
    expect(t?.backgroundColor).toBe("rgba(59, 130, 246, 0.18)");
    expect(t?.borderColor).toBe("rgba(59, 130, 246, 0.5)");
    // 深字由 darkenForText 输出（rgb 三元组），与浅底同系
    expect(t?.color).toBe("rgb(30, 65, 123)");
  });

  it("color 缺失/非法 → undefined（调用方走 gx token 兜底）", () => {
    expect(optionTone(undefined)).toBeUndefined();
    expect(optionTone(null)).toBeUndefined();
    expect(optionTone("not-a-color")).toBeUndefined();
  });

  it("StatusPill 复用 optionTone（非法色降级 gx token，不另写混色）", () => {
    const ok = render(<StatusPill label="进行中" color="#3B82F6" />);
    expect(ok).toContain("rgba(59, 130, 246, 0.18)");
    const bad = render(<StatusPill label="待开始" color="nope" />);
    expect(bad).toContain("border-gx-border");
    expect(bad).toContain("bg-gx-row-hover");
  });
});

// ============================================================
// #693 · OptionColorButton 圆点入口 + ColorPicker
// ============================================================

describe("#693 OptionColorButton · 圆点颜色入口", () => {
  it("关闭态只渲染圆点（h-6 w-6 圆形 + 当前色），无循环变色语义", () => {
    const html = render(
      <OptionColorButton color="#D3F0E4" onChange={() => undefined} />,
    );
    expect(html).toContain('aria-label="设置选项颜色"');
    expect(html).toContain("h-6 w-6");
    expect(html).toContain("rounded-full");
    expect(html).toContain("background-color:#D3F0E4");
    expect(html).not.toContain("点击切换颜色");
  });

  const src = read("./FieldSelectModal.tsx");
  it("点击打开 fixed portal Popover（gx-z-popover 由 Popover 内部给），锚定圆点", () => {
    expect(src).toContain('<Popover');
    expect(src).toContain("fixed");
    expect(src).toContain("anchorEl={anchorRef.current}");
    expect(src).toContain("width={240}");
    expect(src).toContain('onClick={() => setOpen(true)}');
  });

  it("内嵌 components/ColorPicker（完整路径，mode=bg、current=color），非 ui.tsx 同名件", () => {
    expect(src).toContain('import { ColorPicker } from "../../components/ColorPicker"');
    expect(src).toContain('mode="bg"');
    expect(src).toContain("current={color}");
    expect(src).toContain("onClose={() => setOpen(false)}");
  });

  it("onChange 实时写回 option.color；选「无背景」(null) 回落统一默认色", () => {
    expect(src).toContain(
      "onChange={(hex) => onChange(hex ?? OPTION_DEFAULT_COLOR)}",
    );
  });

  it("OPTION_DEFAULT_COLOR 取 COLOR_PALETTE[0]", () => {
    expect(OPTION_DEFAULT_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
    expect(src).toContain("export const OPTION_DEFAULT_COLOR = COLOR_PALETTE[0]!;");
  });
});

// ============================================================
// #693 · 两处面板接线：addOption 默认色、圆点替换 cycleColor
// ============================================================

describe("#693 两处设置面板接线", () => {
  const sheet = read("./FieldEditorSheet.tsx");
  const panel = read("../detail/FieldSettingsPanel.tsx");

  it("cycleColor 已移除（定义与调用都不存在）", () => {
    expect(sheet).not.toContain("cycleColor");
    expect(panel).not.toContain("cycleColor");
  });

  it("选项行用 OptionColorButton，并把 onChange 写回对应 option.color", () => {
    expect(sheet).toContain("<OptionColorButton");
    expect(panel).toContain("<OptionColorButton");
    expect(sheet).toContain("j === i ? { ...x, color: hex } : x");
    expect(panel).toContain("j === i ? { ...x, color: hex } : x");
  });

  it("addOption 新选项 color=OPTION_DEFAULT_COLOR，不再按长度轮转", () => {
    for (const s of [sheet, panel]) {
      expect(s).toContain("color: OPTION_DEFAULT_COLOR");
      expect(s).not.toMatch(/COLOR_PALETTE\[/);
      expect(s).not.toContain("prev.length % ");
    }
  });

  it("OPTION_DEFAULT_COLOR 与 OptionColorButton 均从 FieldSelectModal 单一来源导入", () => {
    expect(sheet).toContain(
      'import FieldSelectModal, { FieldSelectSummary, OptionColorButton, OPTION_DEFAULT_COLOR } from "./FieldSelectModal";',
    );
    expect(panel).toContain(
      'import FieldSelectModal, { FieldSelectSummary, OptionColorButton, OPTION_DEFAULT_COLOR } from "../designer/FieldSelectModal";',
    );
  });
});

// ============================================================
// #693 · SelectPill / DetailLayout pill 对齐 StatusPill
// ============================================================

describe("#693 SelectPill / DetailLayout 选项 pill 对齐", () => {
  const controls = read("../views/field-controls.tsx");
  const detail = read("../detail/DetailLayout.tsx");
  const interaction = read("../../components/interaction.tsx");

  it("三处复用同一个 optionTone，不复制第三套混色", () => {
    expect(controls).toContain('import { optionTone } from "../../components/interaction"');
    expect(detail).toContain('import { optionTone } from "../../components/interaction"');
    expect(controls).toContain("const style = optionTone(option.color)");
    expect(detail).toContain("const style = optionTone(opt?.color)");
    // interaction 内只有 StatusPill 一处定义 optionTone
    expect(interaction.match(/export function optionTone/g)).toHaveLength(1);
  });

  it("不再出现浅底白字（color:#FFFFFF/#000000 硬编码于 pill）", () => {
    // SelectPill 段
    const iPill = controls.indexOf("export function SelectPill");
    const pillSeg = controls.slice(iPill, controls.indexOf("/**", iPill + 10));
    expect(pillSeg).not.toContain('color: "#FFFFFF"');
    // DetailLayout 选项 pill 段
    expect(detail).not.toContain('backgroundColor: "rgba(0,0,0,0.06)"');
    expect(detail).not.toContain('color: "#5F5E5A"');
  });

  it("缺色/非法走 gx token 兜底（border-gx-border bg-gx-row-hover text-gx-text-secondary）", () => {
    expect(controls).toContain("border-gx-border bg-gx-row-hover text-gx-text-secondary");
    expect(detail).toContain("border-gx-border bg-gx-row-hover text-gx-text-secondary");
  });
});

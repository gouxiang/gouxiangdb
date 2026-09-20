// 看板 / 日历视图「已配置好分组/日期字段后冷启动必崩」回归（Minified React error #310）。
//
// 现象：直接打开或刷新看板视图 / 日历视图 URL，整块报「该内容渲染失败」。配置已落库，
// 刷新也回不来——用户一旦配过，这两个视图就永久打不开。
//
// 根因：两个组件在 hooks 之前按「分组/日期字段是否已配置」早返回引导空态。useFields
// 首帧返回 undefined（fields 空 → 走空态，少跑 useState/useMemo），字段数据到达后走主
// 分支（多跑 hook），两次渲染 hook 数量不一致 → React #310。
//
// 锁三件事：
//   G1 首帧 fields 为空 / 次帧 fields 到达（以及反向翻转），hook 序列必须完全一致；
//      空序列也算失败——那说明 hooks 又被早返回跳过了。
//   G2 未配置时的引导空态原样保留（Select + updateView 写 kanbanFieldId / dateFieldId）。
//   G3 两个文件不再挂 react-hooks/rules-of-hooks 豁免（条件 hook 已根治，不是压告警）。
//
// node 环境，无 jsdom、无新增依赖：hook 序列用 React 自己的 dispatcher 记录（把组件当
// 普通函数调用一次即「一次渲染跑过的 hook 序列」），可见行为用 react-dom/server 断言。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import * as React from "react";
import { defaultViewConfig } from "@gx/shared-types";
import type { FieldDTO, RecordDTO, ViewDTO } from "@gx/shared-types";
import type { ViewProps } from "../field-controls";

// ---- 受控替身：只有这三个 hook 的数据来源会随「首帧/次帧」变化 ----
let fields: FieldDTO[] = [];
const RECORDS = [
  {
    id: "rec-1",
    tableId: "tbl-1",
    fields: { "fld-status": "opt-a" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: "u1",
    updatedBy: "u1",
  },
] as unknown as RecordDTO[];

vi.mock("../../../api/hooks", () => ({
  useFields: () => ({ data: fields.length ? fields : undefined }),
  useGXMutations: () => ({
    updateView: { mutateAsync: vi.fn(async () => undefined) },
    updateRecord: { mutateAsync: vi.fn(async () => undefined) },
    createRecord: { mutateAsync: vi.fn(async () => undefined) },
  }),
}));
vi.mock("../../../api/records-paging-hooks", () => ({
  useRecordsBounded: () => ({
    records: RECORDS,
    isLoading: false,
    bounded: false,
    declaredTotal: RECORDS.length,
    degraded: null,
    hasMore: false,
  }),
}));

import KanbanView from "../KanbanView";
import CalendarView from "../CalendarView";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- hook 序列采集器 ----
// React 的 useState/useMemo/... 只是把调用转发给 ReactCurrentDispatcher.current；在 node
// 环境换上一个「记录型 dispatcher」再调用组件函数，即可拿到这次渲染实际跑过的 hook 序列
// （与 fiber 挂载时 mount 阶段的调用顺序完全一致）。
const INTERNALS = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } };
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

function renderHookSeq(render: () => unknown): string[] {
  const seq: string[] = [];
  const noop = () => undefined;
  INTERNALS.ReactCurrentDispatcher.current = {
    useState: (init: unknown) => {
      seq.push("useState");
      return [typeof init === "function" ? (init as () => unknown)() : init, noop];
    },
    useMemo: (fn: () => unknown) => {
      seq.push("useMemo");
      return fn();
    },
    useRef: (v: unknown) => {
      seq.push("useRef");
      return { current: v };
    },
    useCallback: (fn: unknown) => {
      seq.push("useCallback");
      return fn;
    },
    useReducer: (init: unknown) => {
      seq.push("useReducer");
      return [init, noop];
    },
    useEffect: () => seq.push("useEffect"),
    useLayoutEffect: () => seq.push("useLayoutEffect"),
    useInsertionEffect: () => seq.push("useInsertionEffect"),
    useImperativeHandle: () => seq.push("useImperativeHandle"),
    useContext: () => {
      seq.push("useContext");
      return undefined;
    },
    useId: () => {
      seq.push("useId");
      return "gx-test-id";
    },
    useDebugValue: () => undefined,
    useTransition: () => {
      seq.push("useTransition");
      return [false, noop];
    },
    useSyncExternalStore: (_sub: unknown, get: () => unknown) => {
      seq.push("useSyncExternalStore");
      return get();
    },
  };
  try {
    render();
  } finally {
    INTERNALS.ReactCurrentDispatcher.current = null;
  }
  return seq;
}

const STATUS_FIELD = {
  id: "fld-status",
  tableId: "tbl-1",
  name: "状态",
  type: "singleSelect",
  options: [
    { id: "opt-a", name: "待办", color: "#3370FF" },
    { id: "opt-b", name: "完成", color: "#34C724" },
  ],
} as unknown as FieldDTO;
const DATE_FIELD = {
  ...(STATUS_FIELD as object),
  id: "fld-date",
  name: "日期",
  type: "date",
  options: null,
} as unknown as FieldDTO;

const PERMISSIONS = {
  canManageBase: true,
  canManageSchema: true,
  canEditData: true,
  canComment: true,
  canView: true,
};

function props(over: Partial<ViewDTO>): ViewProps {
  return {
    baseId: "base-1",
    tableId: "tbl-1",
    viewId: "view-1",
    view: {
      id: "view-1",
      tableId: "tbl-1",
      name: "视图",
      type: "kanban",
      lockMode: "collaborative",
      order: 0,
      config: defaultViewConfig(),
      createdAt: "2026-01-01T00:00:00.000Z",
      ...over,
    } as ViewDTO,
    permissions: PERMISSIONS,
  };
}
const kanbanProps = (f: string | null) => props({ type: "kanban", config: defaultViewConfig({ kanbanFieldId: f }) });
const calendarProps = (f: string | null) => props({ type: "calendar", config: defaultViewConfig({ dateFieldId: f }) });

const html = (c: React.ComponentType<ViewProps>, p: ViewProps) => renderToStaticMarkup(React.createElement(c, p));

// 两个视图的同一场景，一套断言跑两遍
const CASES = [
  { name: "看板视图", call: () => KanbanView(kanbanProps("fld-status")), field: STATUS_FIELD },
  { name: "日历视图", call: () => CalendarView(calendarProps("fld-date")), field: DATE_FIELD },
];

describe("G1 冷启动首帧 fields 空 → 次帧到达：hook 序列必须一致（#310 判据）", () => {
  for (const c of CASES) {
    it(`${c.name}：两次渲染的 hook 序列完全相同`, () => {
      fields = [];
      const firstFrame = renderHookSeq(c.call);
      fields = [c.field];
      expect(renderHookSeq(c.call)).toEqual(firstFrame);
    });

    it(`${c.name}：首帧（守卫分支）也必须跑完 hooks —— 空序列等于又退回早返回`, () => {
      fields = [];
      const seq = renderHookSeq(c.call);
      expect(seq).toContain("useState");
      expect(seq).toContain("useMemo");
      expect(seq.length).toBeGreaterThan(0);
    });

    it(`${c.name}：反向翻转（字段到达→被清空→再到达）同样安全`, () => {
      fields = [c.field];
      renderHookSeq(c.call);
      fields = [];
      const dropped = renderHookSeq(c.call);
      fields = [c.field];
      expect(renderHookSeq(c.call)).toEqual(dropped);
    });
  }
});

describe("G2 引导空态原样保留：Select 选字段 → updateView 写 config", () => {
  it("字段未到：给「设置…字段」引导 + 可用的 Select（不是崩溃/白屏）", () => {
    fields = [];
    const empty = [
      [KanbanView, kanbanProps("fld-status"), "设置看板分组字段"],
      [CalendarView, calendarProps("fld-date"), "设置日历日期字段"],
    ] as [React.ComponentType<ViewProps>, ViewProps, string][];
    for (const [c, p, tag] of empty) {
      expect(html(c, p)).toContain(tag);
      expect(html(c, p)).toContain("<select");
    }
  });

  it("字段到达：回到主分支（看板列 / 日历格），不再是空态", () => {
    fields = [STATUS_FIELD];
    const k = html(KanbanView, kanbanProps("fld-status"));
    expect(k).not.toContain("设置看板分组字段");
    expect(k).toContain("未分类");
    expect(k).toContain("待办");
    fields = [DATE_FIELD];
    const c = html(CalendarView, calendarProps("fld-date"));
    expect(c).not.toContain("设置日历日期字段");
    expect(c).toContain("今天");
  });

  it("空态是独立子组件（父组件 hooks 无条件跑完的前提）", () => {
    expect(read("../KanbanView.tsx")).toContain("function KanbanSetup");
    expect(read("../CalendarView.tsx")).toContain("function CalendarSetup");
  });
});

describe("G3 条件 hook 已根治：不再挂 rules-of-hooks 豁免", () => {
  it("KanbanView / CalendarView 不再有 GX-LINT-DEBT-1 技术债注释", () => {
    for (const f of ["../KanbanView.tsx", "../CalendarView.tsx"]) {
      const src = read(f);
      expect(src).not.toContain("react-hooks/rules-of-hooks");
      expect(src).not.toContain("GX-LINT-DEBT-1");
    }
  });

  it("NodeStyleBar 同类隐患同步收口：守卫之前不得再有 hook", () => {
    const src = read("../../kb/canvas/NodeStyleBar.tsx");
    expect(src).not.toContain("react-hooks/rules-of-hooks");
    // 守卫结果不稳定（style 取 plait 实时选区，可空可非空），故所有 useState 必须在守卫之前
    const guardAt = src.indexOf("if (!board || !style) return null;");
    expect(guardAt).toBeGreaterThan(0);
    expect(src.lastIndexOf("useState(")).toBeLessThan(guardAt);
  });
});

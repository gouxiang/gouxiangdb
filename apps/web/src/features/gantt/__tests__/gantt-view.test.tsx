// GanttView 组件级回归（node 环境，react-dom/server + vi.mock，沿用仓库既有 .test.tsx
// 惯用写法：apps/web 无 jsdom / @testing-library，禁止新增依赖；指针交互的 DOM 事件流
// 不在自动化范围，拖拽写回的日期几何由 gantt-scale/gantt-tasks 纯函数测试覆盖，
// 本文件锁渲染契约与编辑权限门控）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultViewConfig } from "@gx/shared-types";
import type {
  FieldDTO,
  RecordDTO,
  ViewDTO,
  ViewConfig,
} from "@gx/shared-types";
import type { ViewProps } from "../../views/field-controls";

// ---- 受控替身：渲染输入（fields/records/loading/bounded）由各用例改写 ----
let fields: FieldDTO[] = [];
let records: RecordDTO[] = [];
let isLoading = false;
let boundedFlag = false;

vi.mock("../../../api/hooks", () => ({
  useFields: () => ({ data: fields.length ? fields : undefined }),
  useGXMutations: () => ({
    updateView: { mutateAsync: vi.fn(async () => undefined) },
    updateRecord: { mutateAsync: vi.fn(async () => undefined) },
  }),
}));
vi.mock("../../../api/records-paging-hooks", () => ({
  useRecordsBounded: () => ({
    records,
    fields,
    bounded: boundedFlag,
    declaredTotal: 500,
    isLoading,
    degraded: [],
  }),
}));

import GanttView from "../GanttView";

const TITLE_FIELD = {
  id: "fld-title",
  name: "任务",
  type: "text",
  options: null,
} as unknown as FieldDTO;
const START_FIELD = {
  id: "fld-start",
  name: "开始日期",
  type: "date",
  options: null,
} as unknown as FieldDTO;
const END_FIELD = {
  id: "fld-end",
  name: "结束日期",
  type: "date",
  options: null,
} as unknown as FieldDTO;

const rec = (id: string, title: string, start: string, end: string): RecordDTO =>
  ({
    id,
    tableId: "tbl-1",
    fields: {
      "fld-title": title,
      "fld-start": start,
      "fld-end": end,
    },
  }) as unknown as RecordDTO;

const TASK_RECORDS = [
  rec("rec-1", "需求评审", "2026-03-02", "2026-03-04"),
  rec("rec-2", "接口开发", "2026-03-05", "2026-03-10"),
];

function makeProps(
  configOver: Partial<ViewConfig>,
  canEditData: boolean,
): ViewProps {
  return {
    baseId: "base-1",
    tableId: "tbl-1",
    viewId: "view-1",
    view: {
      id: "view-1",
      tableId: "tbl-1",
      name: "甘特图",
      type: "gantt",
      lockMode: "collaborative",
      order: 0,
      config: defaultViewConfig(configOver),
      createdAt: "2026-01-01T00:00:00.000Z",
    } as ViewDTO,
    permissions: {
      canManageBase: true,
      canManageSchema: true,
      canEditData,
      canComment: true,
      canView: true,
    },
  };
}

const CONFIGURED: Partial<ViewConfig> = {
  cardFieldIds: ["fld-title"],
  ganttStartFieldId: "fld-start",
  ganttEndFieldId: "fld-end",
  ganttZoom: "day",
};

beforeEach(() => {
  fields = [TITLE_FIELD, START_FIELD, END_FIELD];
  records = TASK_RECORDS;
  isLoading = false;
  boundedFlag = false;
});

const html = (canEdit = true, over: Partial<ViewConfig> = CONFIGURED) =>
  renderToStaticMarkup(<GanttView {...makeProps(over, canEdit)} />);

describe("GanttView 引导空态", () => {
  it("未配置开始字段时显示 Setup 引导（字段已存在，只是未绑定）", () => {
    const out = html(true, {
      cardFieldIds: ["fld-title"],
      ganttStartFieldId: null,
      ganttEndFieldId: "fld-end",
    });
    expect(out).toContain("设置甘特图开始日期字段");
    expect(out).toContain("<select");
    expect(out).not.toContain("需求评审");
  });
});

describe("GanttView 主体渲染", () => {
  it("配置并取到数据后渲染任务标题与任务名列表头", () => {
    const out = html();
    expect(out).toContain("需求评审");
    expect(out).toContain("接口开发");
    expect(out).toContain("任务名");
  });

  it("缩放控件存在：日/周/月/季/年 五档按钮", () => {
    const out = html();
    expect(out).toContain("时间刻度");
    for (const label of [">日</button>", ">周</button>", ">月</button>", ">季</button>", ">年</button>"]) {
      expect(out).toContain(label);
    }
    // 当前档位 day 选中
    expect(out).toContain('data-gx-draggable="true"');
  });

  it("加载中渲染 Spinner 而非任务区", () => {
    isLoading = true;
    const out = html();
    expect(out).not.toContain("需求评审");
    expect(out).toContain("animate-spin");
  });

  it("bounded 截断时顶部显示诚实的截断提示", () => {
    boundedFlag = true;
    const out = html();
    expect(out).toContain("当前仅显示前");
    expect(out).toContain("500");
  });
});

describe("GanttView 编辑权限门控", () => {
  it("canEditData=false：任务条不渲染拖拽能力标记，也不挂指针处理（aria-disabled）", () => {
    const out = html(false);
    expect(out).not.toContain('data-gx-draggable="true"');
    expect(out).toContain('aria-disabled="true"');
    // 任务名仍可看（点击开记录由 onOpenRecord 决定，标题照常渲染）
    expect(out).toContain("需求评审");
  });

  it("canEditData=true：任务条标记可拖拽并挂指针处理器", () => {
    const out = html(true);
    expect(out).toContain('data-gx-draggable="true"');
    expect(out).not.toContain('aria-disabled="true"');
  });
});

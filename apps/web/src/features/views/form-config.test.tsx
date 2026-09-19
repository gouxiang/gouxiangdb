// apps/web/src/features/views/form-config.test.tsx
// 表单视图配置回归（node 环境，react-dom/server，无 jsdom、无新增依赖）
//
// 锁的是 P2「提示引导到不存在的地方」修复，两段各自有证据：
//   3a  FormView 提示不再承诺「可在视图设置中调整」—— 原来视图设置根本没有表单配置入口
//   3b  表单配置真正可写：字段显隐 / 顺序 / 必填 / 标题 / 描述 → view.config 三键
//
// 纯函数（autoFormFields / reconcileFormFields / moveFormField）做行为断言；
// 组件接线（写入哪三个键、面板挂在哪）用 SSR + 源码断言锁定。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FieldDTO, PermissionSet, ViewDTO, ViewType } from "@gx/shared-types";
import { defaultViewConfig } from "@gx/shared-types";
import FormView from "./FormView";
import { autoFormFields, moveFormField, reconcileFormFields } from "./form-config";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const field = (id: string, name: string, type = "text"): FieldDTO =>
  ({ id, name, type, options: null, order: 0 }) as unknown as FieldDTO;

const FIELDS: FieldDTO[] = [
  field("f1", "标题"),
  field("f2", "数量", "number"),
  field("created1", "创建时间", "createdTime"),
  field("f3", "备注", "longText"),
];

const viewOf = (type: ViewType, overrides: Record<string, unknown> = {}): ViewDTO =>
  ({
    id: "v1",
    tableId: "t1",
    name: "表单视图",
    type,
    lockMode: "collaborative",
    order: 0,
    config: { ...defaultViewConfig(), ...overrides },
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as ViewDTO;

describe("autoFormFields：与表单视图渲染同一口径", () => {
  it("排除系统字段，label 取字段名，required 跟随字段", () => {
    const out = autoFormFields([{ ...field("f1", "标题"), required: true } as FieldDTO, field("created1", "创建时间", "createdTime")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ fieldId: "f1", label: "标题", help: "", required: true, hidden: false });
  });

  it("顺序与字段顺序一致，help 初始为空", () => {
    expect(autoFormFields(FIELDS).map((f) => f.fieldId)).toEqual(["f1", "f2", "f3"]);
  });
});

describe("moveFormField：上移/下移且越界不动", () => {
  const list = autoFormFields(FIELDS);

  it("上移：第 2 项换到第 1 位", () => {
    expect(moveFormField(list, 1, -1).map((f) => f.fieldId)).toEqual(["f2", "f1", "f3"]);
  });

  it("下移：第 1 项换到第 2 位", () => {
    expect(moveFormField(list, 0, 1).map((f) => f.fieldId)).toEqual(["f2", "f1", "f3"]);
  });

  it("越界返回原数组（首尾不环绕，长度不变）", () => {
    expect(moveFormField(list, 0, -1)).toBe(list);
    expect(moveFormField(list, list.length - 1, 1)).toBe(list);
    expect(moveFormField(list, 99, -1)).toBe(list);
  });
});

describe("reconcileFormFields：与当前表字段对齐", () => {
  it("保留已配置顺序与用户改动（label/必填/隐藏）", () => {
    const cfg = [
      { fieldId: "f3", label: "备注（必填）", help: "", required: true, hidden: false },
      { fieldId: "f1", label: "标题", help: "", required: false, hidden: true },
    ];
    const out = reconcileFormFields(cfg, FIELDS);
    expect(out.slice(0, 2)).toEqual(cfg); // 顺序与配置一致，改动不丢
    expect(out.map((f) => f.fieldId)).toEqual(["f3", "f1", "f2"]); // f2 追加在末尾
  });

  it("表里已删除的字段从配置剔除（不渲染指向不存在字段的表单项）", () => {
    const cfg = [{ fieldId: "gone", label: "已删字段", help: "", required: false, hidden: false }];
    expect(reconcileFormFields(cfg, FIELDS).map((f) => f.fieldId)).toEqual(["f1", "f2", "f3"]);
  });

  it("未配置（空数组）→ 等价于自动生成", () => {
    expect(reconcileFormFields([], FIELDS)).toEqual(autoFormFields(FIELDS));
  });
});

describe("3a：FormView 提示不再指向不存在的功能", () => {
  const PERMS: PermissionSet = {
    canManageBase: false,
    canManageSchema: false,
    canEditData: true,
    canComment: false,
    canView: true,
  };

  const renderFormView = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // SSR 下 query 不会解析，直接把字段塞进缓存，让 FormView 走「已加载」分支
    qc.setQueryData(["fields", "t1"], FIELDS);
    qc.setQueryData(["tables", "b1"], [{ id: "t1", name: "测试表" }]);
    return render(
      <QueryClientProvider client={qc}>
        <FormView
          baseId="b1"
          tableId="t1"
          viewId="v1"
          view={viewOf("form")}
          permissions={PERMS}
        />
      </QueryClientProvider>,
    );
  };

  it("自动生成的提示写明入口是顶栏「视图设置」，不再泛泛承诺「可在视图设置中调整」", () => {
    const html = renderFormView();
    expect(html).toContain("顶栏「视图设置」");
    // 旧的误导文案整句不得再出现
    expect(html).not.toContain("可在视图设置中调整");
  });
});

describe("3b：配置区真的写 view.config 三键，且入口真的挂上了", () => {
  it("FormConfigSection 只提交 formFields/formTitle/formDescription 三键（后端 config 浅合并）", () => {
    const src = read("./FormConfigSection.tsx");
    expect(src).toContain("updateView.mutateAsync");
    expect(src).not.toContain("fetch("); // 禁裸 fetch，一律走 api/client
    for (const key of ["formFields", "formTitle", "formDescription"]) {
      expect(src).toContain(`${key}:`);
    }
  });

  it("ViewSettingsPanel：表单视图才挂表单配置区（其它视图不受影响）", () => {
    const src = read("../designer/ViewSettingsPanel.tsx");
    expect(src).toContain('view.type === "form"');
    expect(src).toContain("FormConfigSection");
  });

  it("TopBar 的视图设置不再是占位文案，已接入真实面板", () => {
    const src = read("../shell/TopBar.tsx");
    expect(src).toContain("ViewSettingsModal");
    expect(src).not.toContain("视图设置面板将在 designer 模块接入");
  });

  it("FormView 与配置区共用 autoFormFields（两处口径不会分叉）", () => {
    expect(read("./FormView.tsx")).toContain("autoFormFields");
    expect(read("./FormConfigSection.tsx")).toContain("autoFormFields");
  });
});

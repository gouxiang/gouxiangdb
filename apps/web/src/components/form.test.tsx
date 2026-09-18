// 阶段 2 表单骨架回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// 锁的是「阶段 2 表单骨架不回退」：
//   R-F-01  12 栅格 + gap 12；字段跨度只允许 12/6/4/8（span={5} 必须编译不过，见末尾用例）
//   R-F-03  分区之间 24px + 1px 发丝线；分区内字段间距 16px
//   R-F-05  字段高度只有三档：32 紧凑 / 34 标准 / auto 多行
//   R-F-06  标签统一上置（控件上方 6px）
//   R-F-07  必填 `*`；R-F-08 选填「选填」二字
//   R-F-11  错误态 = 控件下方 danger 文案 + 图标（不用 toast）
//   R-F-12  错误/帮助行固定 16px 预留，报错与不报错高度一致
//   R-F-15  按钮区：页面表单左对齐、弹窗/抽屉右对齐，顺序「次要 → 主要」
//   R-F-17  禁用逻辑 + R-D-09 禁用必须带 title 说明原因

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Form,
  FormActions,
  FormBanner,
  FormField,
  FormRow,
  FormSection,
} from "./form";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("阶段2 · FormRow 12 栅格（R-F-01/02）", () => {
  it("FormRow 挂 gx-form-row，栅格与 gap 由全局 CSS 保证 12 列 + 12px", () => {
    expect(renderToStaticMarkup(<FormRow>x</FormRow>)).toContain("gx-form-row");
    // 栅格与间距写在 index.css（Tailwind 单类无法表达 12 列 + 容器降列）
    expect(css).toMatch(/\.gx-form-row\s*\{[^}]*repeat\(12,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.gx-form-row\s*\{[^}]*gap:\s*12px/);
  });

  it("R-F-02 字段最小宽 200px：容器窄于 412px 降为 1 列，窄于 624px 时 4 跨降为半行", () => {
    expect(css).toMatch(/@container\s*\(max-width:\s*411px\)/);
    expect(css).toMatch(/@container\s*\(min-width:\s*412px\)\s*and\s*\(max-width:\s*623px\)/);
    // 非 FormField 的直接子级默认占满整行，避免被塞进 1/12 列
    expect(css).toMatch(/\.gx-form-row\s*>\s*\*\s*\{[^}]*span 12/);
  });

  it("跨度类名按 span 输出，且只认 12/6/4/8", () => {
    expect(renderToStaticMarkup(<FormField span={6} label="a">x</FormField>)).toContain("gx-field-6");
    expect(renderToStaticMarkup(<FormField span={4} label="a">x</FormField>)).toContain("gx-field-4");
    expect(renderToStaticMarkup(<FormField span={8} label="a">x</FormField>)).toContain("gx-field-8");
    expect(renderToStaticMarkup(<FormField label="a">x</FormField>)).toContain("gx-field-12");
    for (const s of ["12", "6", "4", "8"]) {
      expect(css).toContain(`.gx-field-${s}`);
    }
    // 5 / 7 等不规则跨度不得存在
    expect(css).not.toContain(".gx-field-5");
    expect(css).not.toContain(".gx-field-7");
  });
});

describe("阶段2 · FormField 三段式与 16px 错误预留（R-F-06/07/08/11/12）", () => {
  it("三段结构齐备：标签区 / 控件区 / 错误区", () => {
    const html = renderToStaticMarkup(
      <FormField label="字段名称" help="帮助">
        <input />
      </FormField>,
    );
    expect(html).toContain(">字段名称<");
    expect(html).toContain("gx-field-ctl");
    expect(html).toContain(">帮助<");
  });

  it("R-F-12 错误/帮助行恒为 16px（h-4）：报错与不报错都占位，不跳动", () => {
    const clean = renderToStaticMarkup(<FormField label="a">x</FormField>);
    const withHelp = renderToStaticMarkup(<FormField label="a" help="h">x</FormField>);
    const withError = renderToStaticMarkup(<FormField label="a" error="错了">x</FormField>);
    for (const html of [clean, withHelp, withError]) {
      expect(html).toMatch(/class="[^"]*\bh-4\b[^"]*"/);
    }
    // 无错时该行为空（只占位），有错时才出现文案与图标
    expect(clean).not.toContain("错了");
    expect(withError).toContain("错了");
    expect(withError).toContain("text-gx-danger");
  });

  it("R-F-11 错误不用 toast：错误文案落在字段内，且控件边框转 danger", () => {
    const html = renderToStaticMarkup(<FormField label="a" error="格式不正确">x</FormField>);
    expect(html).toContain("格式不正确");
    expect(html).toContain("border-gx-danger");
    expect(html).toContain('data-gx-error="true"');
  });

  it("R-F-07 必填标 `*`，R-F-08 选填标「选填」二字", () => {
    const req = renderToStaticMarkup(<FormField label="名称" required>x</FormField>);
    expect(req).toContain("text-gx-danger");
    expect(req).toContain("*");
    const opt = renderToStaticMarkup(<FormField label="说明" optional>x</FormField>);
    expect(opt).toContain("选填");
  });

  it("R-F-06 标签上置且位于控件上方 6px", () => {
    const html = renderToStaticMarkup(<FormField label="名称">x</FormField>);
    expect(html).toMatch(/mb-gx-sm[^"]*"/); // 6px
    // 标签在控件区之前
    expect(html.indexOf(">名称<")).toBeLessThan(html.indexOf("gx-field-ctl"));
  });

  it("R-F-05 控件高度只有三档：34 标准 / 32 紧凑 / auto", () => {
    const standard = renderToStaticMarkup(
      <Form variant="modal">
        <FormField label="a">x</FormField>
      </Form>,
    );
    expect(standard).toContain("gx-field-ctl-34");
    const compact = renderToStaticMarkup(
      <Form variant="inline">
        <FormField label="a">x</FormField>
      </Form>,
    );
    expect(compact).toContain("gx-field-ctl-32");
    const auto = renderToStaticMarkup(<FormField label="a" control="auto">x</FormField>);
    expect(auto).toContain("gx-field-ctl-auto");
    expect(css).toMatch(/\.gx-field-ctl-32\s*>[^}]*height:\s*32px/);
    expect(css).toMatch(/\.gx-field-ctl-34\s*>[^}]*height:\s*34px/);
    // 只允许这三档，不得出现 36/38/40 等自造高度
    expect(css).not.toMatch(/\.gx-field-ctl-(36|38|40)\b/);
  });
});

describe("阶段2 · FormSection / Form 分区间距（R-F-03）", () => {
  it("分区内字段间距 16px，分区之间 24px + 发丝线", () => {
    const section = renderToStaticMarkup(<FormSection title="基本属性">x</FormSection>);
    expect(section).toContain("gap-4"); // 16px
    expect(section).toContain('data-gx-section="true"');
    const form = renderToStaticMarkup(<Form>{"a"}</Form>);
    expect(form).toContain("gap-6"); // 24px
    expect(form).toContain("border-gx-hairline");
  });

  it("R-F-07 整表必填时改在分区标题后标「全部必填」", () => {
    const html = renderToStaticMarkup(<FormSection title="基本属性" allRequired>x</FormSection>);
    expect(html).toContain("全部必填");
  });
});

describe("阶段2 · FormActions 按钮区（R-F-15/16/17, R-D-09）", () => {
  it("R-F-15 默认右对齐（弹窗/抽屉），页面表单左对齐", () => {
    const right = renderToStaticMarkup(<FormActions onSubmit={() => {}} />);
    expect(right).toContain("justify-end");
    const left = renderToStaticMarkup(<FormActions align="left" onSubmit={() => {}} />);
    expect(left).toContain("justify-start");
  });

  it("R-F-15 顺序「次要 → 主要」：取消在保存之前，主按钮高 32 + 圆角 8", () => {
    const html = renderToStaticMarkup(
      <FormActions onCancel={() => {}} onSubmit={() => {}} submitText="保存修改" />,
    );
    expect(html.indexOf("取消")).toBeLessThan(html.indexOf("保存修改"));
    expect(html).toMatch(/class="[^"]*\bh-8\b[^"]*rounded-gx-lg[^"]*"/);
  });

  it("R-F-17 必填未填 / 提交中 → 主按钮禁用；R-D-09 禁用必须带 title", () => {
    const disabled = renderToStaticMarkup(
      <FormActions onSubmit={() => {}} submitDisabled submitDisabledReason="请先填写字段名称" />,
    );
    expect(disabled).toContain("disabled");
    expect(disabled).toContain('title="请先填写字段名称"');
    const busy = renderToStaticMarkup(<FormActions onSubmit={() => {}} submitting />);
    expect(busy).toContain("disabled");
    // 禁用只降透明度，不改底色
    expect(disabled).toContain("disabled:opacity-50");
    expect(disabled).toContain("bg-gx-accent");
  });

  it("R-F-18 重置仅在有改动时可用", () => {
    const clean = renderToStaticMarkup(<FormActions onSubmit={() => {}} onReset={() => {}} resetEnabled={false} />);
    expect(clean).toContain('title="表单未改动"');
    const dirty = renderToStaticMarkup(<FormActions onSubmit={() => {}} onReset={() => {}} resetEnabled />);
    expect(dirty).not.toContain('title="表单未改动"');
  });

  it("R-F-16 危险表单主按钮用 danger 底，尺寸与禁用逻辑不变", () => {
    const html = renderToStaticMarkup(<FormActions onSubmit={() => {}} danger submitText="永久注销" />);
    expect(html).toContain("bg-gx-danger");
    expect(html).toContain("h-8");
  });
});

describe("阶段2 · FormBanner（R-F-13）", () => {
  it("无法归属字段的错误落在表单顶部横幅，可关闭", () => {
    const html = renderToStaticMarkup(<FormBanner message="保存失败：字段名重复" onDismiss={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("保存失败：字段名重复");
    expect(html).toContain("bg-gx-danger-bg");
    expect(html).toContain("text-gx-danger");
  });
});

describe("阶段2 · 三种变体共用同一套骨架（R-F-21~25）", () => {
  it("行内 / 弹窗 / 抽屉三种变体渲染出的是同一组骨架类名", () => {
    const skeleton = (variant: "inline" | "modal" | "drawer") =>
      renderToStaticMarkup(
        <Form variant={variant}>
          <FormSection title="分区">
            <FormRow>
              <FormField label="字段" error="错误">
                <input />
              </FormField>
            </FormRow>
          </FormSection>
        </Form>,
      );
    for (const v of ["inline", "modal", "drawer"] as const) {
      const html = skeleton(v);
      expect(html).toContain("gx-form");
      expect(html).toContain("gx-form-row");
      expect(html).toContain("gx-field-12");
      expect(html).toContain("gx-field-ctl");
      expect(html).toMatch(/\bh-4\b/);
    }
  });
});

describe("阶段2 · 已收敛表单不再各写一套（回归护栏）", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("FieldSettingsPanel 已改用共享骨架，不再自留 Section", () => {
    const src = read("features/detail/FieldSettingsPanel.tsx");
    expect(src).toContain('from "../../components/form"');
    expect(src).toContain("<FormSection");
    expect(src).toContain("<FormRow>");
    expect(src).toContain("<FormField");
    expect(src).not.toMatch(/function Section\(/);
  });

  it("FieldEditorSheet / FilterRuleModal / RoleManager / PersonalCenterDrawer 均已接入共享骨架", () => {
    for (const p of [
      "features/designer/FieldEditorSheet.tsx",
      "features/designer/FilterRuleModal.tsx",
      "features/contacts/RoleManager.tsx",
      "features/settings/PersonalCenterDrawer.tsx",
    ]) {
      const src = read(p);
      expect(src).toContain("components/form");
      expect(src).toMatch(/<Form(Row|Field|Section|Actions|Banner)?[\s/>]/);
    }
  });

  it("PersonalCenterDrawer 不再自留 FormField（与共享件同名易混淆）", () => {
    const src = read("features/settings/PersonalCenterDrawer.tsx");
    expect(src).not.toMatch(/function FormField\(/);
  });

  it("R-F-01 编译期封死不规则跨度：span={5} 必须类型报错", () => {
    // 若哪天把 FieldSpan 放宽到 number，下面的 @ts-expect-error 会变成"未使用的指令"而编译失败，
    // 从而在 typecheck 阶段就拦住回归。
    const illegal = (
      // @ts-expect-error R-F-01：栅格跨度禁止 5（只允许 12 / 6 / 4 / 8）
      <FormField span={5} label="非法跨度">
        x
      </FormField>
    );
    expect(renderToStaticMarkup(illegal)).toContain("gx-field-5");
  });
});

// apps/web/src/features/views/form-config.ts
// 表单视图「表单字段配置」的纯函数层（可单测，无 React / 无网络依赖）
//
// 写入契约（已核对后端，不臆造）：
//   PATCH /api/views/:viewId  body.config 是**浅合并**进既有 view.config
//   （apps/api/src/routes/views.ts:170-173：{ ...current, ...parsed.data.config }）。
//   所以前端只需提交 { formFields, formTitle, formDescription } 三个键，
//   不用回传整个 config，也不会冲掉 hiddenFieldIds / filters 等其它配置。
//   ViewConfig 三键定义在 packages/shared-types/src/views.ts:124-127，
//   FormFieldConfig = { fieldId, label, help, required, hidden }。

import type { FieldDTO, FormFieldConfig } from "@gx/shared-types";

/** 系统字段不进表单（自动生成时的过滤口径，与表单视图渲染保持一致） */
export const FORM_SYSTEM_FIELD_TYPES: readonly string[] = [
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
];

/**
 * 按表的全部字段自动生成表单字段配置（未显式配置时的兜底）。
 * FormView 的渲染与设置面板的初始草稿共用它，保证两处口径一致。
 */
export function autoFormFields(fields: FieldDTO[]): FormFieldConfig[] {
  return fields
    .filter((f) => !FORM_SYSTEM_FIELD_TYPES.includes(f.type))
    .map((f) => ({
      fieldId: f.id,
      label: f.name,
      help: "",
      required: !!f.required,
      hidden: false,
    }));
}

/**
 * 已配置的 formFields 与当前表字段对齐：
 *  - 保留已配置项的 label/help/required/hidden 与顺序；
 *  - 表上新加的字段追加到末尾（默认显示）；
 *  - 表里已删除的字段从配置中剔除（避免渲染出指向不存在字段的表单项）。
 */
export function reconcileFormFields(
  configured: FormFieldConfig[],
  fields: FieldDTO[],
): FormFieldConfig[] {
  const byId = new Map<string, FieldDTO>(fields.map((f) => [f.id as string, f]));
  const kept = configured.filter((c) => byId.has(c.fieldId));
  const seen = new Set(kept.map((c) => c.fieldId));
  const appended = autoFormFields(fields.filter((f) => !seen.has(f.id)));
  return [...kept, ...appended];
}

/** 上移（delta=-1）/ 下移（delta=+1）；越界返回原数组，不产生副作用 */
export function moveFormField(
  list: FormFieldConfig[],
  index: number,
  delta: number,
): FormFieldConfig[] {
  const next = index + delta;
  if (index < 0 || index >= list.length || next < 0 || next >= list.length) return list;
  const out = [...list];
  const [it] = out.splice(index, 1);
  out.splice(next, 0, it);
  return out;
}

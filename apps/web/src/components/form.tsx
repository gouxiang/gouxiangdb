// apps/web/src/components/form.tsx
// 阶段 2 · 统一表单骨架（UI-SPEC v1.0 §2：R-F-01~R-F-25，五态见 R-D-07~12）
//
// 设计前提（规范原文）：
//   R-F-01  栅格统一 12 栅格 + gap 12；字段占 12 / 6 / 4 / 8+4，禁止 5/7 等不规则跨度
//   R-F-02  字段最小宽 200px；容器窄于 200×n + 12×(n-1) 时自动降列 3→2→1
//   R-F-03  分区之间 24px + 1px 发丝线；分区内字段间距 16px
//   R-F-04  同行字段基线对齐（标签与标签齐、控件与控件齐）；长文本独占整行
//   R-F-05  字段高度只有三档：32 紧凑 / 34 标准 / 自动（多行）
//   R-F-06  标签统一上置（控件上方 6px）
//   R-F-07  必填用标签后 `*`，色 danger
//   R-F-08  选填字段标签后加灰色「选填」
//   R-F-10  校验三段式：失焦校验 / 提交全量校验 / 已报错字段输入时实时消错
//   R-F-12  错误文案写在控件下方**固定预留的 16px 行**内，出现/消失不改变布局高度
//   R-F-13  无法归属字段的服务端错误 → 表单顶部横幅
//   R-F-15  按钮区固定在容器底部：页面表单左对齐、弹窗/抽屉右对齐，顺序「次要 → 主要」
//   R-F-16  主按钮 accent 底 + 白字 + 高 32 + padding 12 + 圆角 8；次按钮 control 底 + 次级字
//   R-F-17  禁用逻辑：必填未填全 / 有字段错误 / 提交中 → 主按钮禁用（opacity .5，不改底色）
//   R-D-09  禁用必须带 title 说明原因
//   R-D-11  只读：去边框去底色，不用 disabled（disabled 无法选中复制）
//   R-F-21~25 行内 / 弹窗 / 抽屉 / 独立页 四变体**共用本骨架**，不得各写一套
//
// 使用方式：
//   <Form variant="modal">
//     <FormSection title="基本属性" description="…">
//       <FormRow>
//         <FormField span={6} label="字段名" required help="…" error={err}>…</FormField>
//         <FormField span={6} label="提示">…</FormField>
//       </FormRow>
//     </FormSection>
//     <FormActions submitDisabled={!canSave} onSubmit={save} />
//   </Form>

import {
  createContext,
  useContext,
  useId,
  useMemo,
  type ReactNode,
} from "react";
import { clsx } from "clsx";
import { Icon } from "./icons";

// ============ 类型 ============

/** R-F-21~24 四变体。变体只影响「控件高度档位默认值」与「按钮区对齐」，骨架本身共用。 */
export type FormVariant = "inline" | "modal" | "drawer" | "page";

/** R-F-05 字段高度三档。禁止 36/38/40 等自造高度。 */
export type FieldControlSize = "compact" | "standard" | "auto";

/** R-F-01 允许的栅格跨度。联合类型在编译期就排除 5 / 7 等不规则跨度。 */
export type FieldSpan = 4 | 6 | 8 | 12;

const CONTROL_SIZE_CLASS: Record<FieldControlSize, string> = {
  compact: "gx-field-ctl-32",
  standard: "gx-field-ctl-34",
  auto: "gx-field-ctl-auto",
};

/** R-F-05：32 用于表格内/筛选，34 用于弹窗/抽屉/页面表单。 */
const VARIANT_DEFAULT_CONTROL: Record<FormVariant, FieldControlSize> = {
  inline: "compact",
  modal: "standard",
  drawer: "standard",
  page: "standard",
};

// ============ 上下文：由 Form 下发控件高度档位 ============

interface FormContextValue {
  variant: FormVariant;
  control: FieldControlSize;
}

const FormContext = createContext<FormContextValue>({
  variant: "page",
  control: "compact",
});

/** 未在 <Form> 内使用时，回退到「紧凑 32」，与既有 Input/Select 的默认高度一致，避免意外变高。 */
function useFormContext(): FormContextValue {
  return useContext(FormContext);
}

// ============ Form：表单容器 ============

export interface FormProps {
  /** 变体：决定控件高度默认档与按钮区对齐；骨架不随变体分叉 */
  variant?: FormVariant;
  /** 覆盖变体默认的控件高度档位（R-F-05 三档之一） */
  control?: FieldControlSize;
  /** R-F: 表单容器 padding 20/24。嵌进已有 padding 的 Modal/抽屉体时关闭。 */
  padding?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Form({
  variant = "page",
  control,
  padding = true,
  className,
  children,
}: FormProps) {
  const ctx = useMemo<FormContextValue>(
    () => ({ variant, control: control ?? VARIANT_DEFAULT_CONTROL[variant] }),
    [variant, control],
  );
  return (
    <FormContext.Provider value={ctx}>
      <div
        data-gx-form={variant}
        className={clsx(
          "gx-form flex flex-col gap-6", // R-F-03 分区之间 24px
          // R-F-03 分区之间的 1px 发丝线（只在相邻分区之间出现，首个分区不画）
          "[&>[data-gx-section]+[data-gx-section]]:border-t",
          "[&>[data-gx-section]+[data-gx-section]]:border-gx-hairline",
          padding && "px-gx-3xl py-gx-xxl", // 24 / 20
          className,
        )}
      >
        {children}
      </div>
    </FormContext.Provider>
  );
}

// ============ FormSection：分区 ============

export interface FormSectionProps {
  title?: ReactNode;
  /** 分区副说明（11px / hint 色） */
  description?: ReactNode;
  /** R-F-07：整表必填时改在分区标题后标「全部必填」，不逐个标 * */
  allRequired?: boolean;
  /** 标题行右侧附加内容 */
  extra?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function FormSection({
  title,
  description,
  allRequired,
  extra,
  className,
  children,
}: FormSectionProps) {
  return (
    <section
      data-gx-section="true"
      className={clsx("flex flex-col gap-4", className)} // R-F-03 分区内字段间距 16px
    >
      {(title || extra) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* 分区标题 13px/600/#16203A + 可选副说明 11px/#8A94AC */}
            <div className="text-gx-13 font-semibold text-gx-text-primary">
              {title}
              {allRequired && (
                <span className="ml-2 text-gx-11 font-regular text-gx-text-hint">全部必填</span>
              )}
            </div>
            {description && (
              <div className="mt-0.5 text-gx-11 text-gx-text-hint">{description}</div>
            )}
          </div>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

// ============ FormRow：12 栅格行 ============

export interface FormRowProps {
  /**
   * 本行最大列数（用于 R-F-02 的降列判定需要容器查询上下文）。
   * 单列行（默认）不加 container-type，避免给既有布局引入 containment 副作用。
   */
  cols?: 1 | 2 | 3;
  className?: string;
  children?: ReactNode;
}

export function FormRow({ cols = 1, className, children }: FormRowProps) {
  return (
    <div
      data-gx-row="true"
      className={clsx(
        "gx-form-row",
        cols > 1 && "gx-form-row--multi",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ============ FormField：三段式字段 ============

export interface FormFieldProps {
  /** 标签（上置，控件上方 6px）。缺省时不渲染标签区，控件区与错误区仍按骨架占位。 */
  label?: ReactNode;
  /** R-F-01 栅格跨度，只允许 12 / 6 / 4 / 8 */
  span?: FieldSpan;
  /** R-F-05 控件高度档位；缺省取 <Form> 上下文的档位 */
  control?: FieldControlSize;
  /** R-F-07 必填：标签后红色 `*` */
  required?: boolean;
  /** R-F-08 选填：标签后灰色「选填」 */
  optional?: boolean;
  /** 帮助文案（格式要求等）。与 error 共用下方 16px 预留行，error 优先。 */
  help?: ReactNode;
  /** R-F-11 错误文案：控件下方 11px danger 色 + 图标；不用 toast 报字段级错误 */
  error?: ReactNode;
  /** 标签行右端附加内容（字数统计等） */
  labelExtra?: ReactNode;
  /** 关联控件 id（无障碍） */
  htmlFor?: string;
  className?: string;
  children?: ReactNode;
}

export function FormField({
  label,
  span = 12,
  control,
  required,
  optional,
  help,
  error,
  labelExtra,
  htmlFor,
  className,
  children,
}: FormFieldProps) {
  const ctx = useFormContext();
  const size = control ?? ctx.control;
  const autoId = useId();
  const forId = htmlFor ?? (label ? `gx-f-${autoId}` : undefined);
  const hasError = !!error;

  return (
    <div
      data-gx-field="true"
      data-gx-error={hasError ? "true" : undefined}
      className={clsx("gx-field", `gx-field-${span}`, "flex flex-col", className)}
    >
      {/* ① 标签区 */}
      {label && (
        <div className="mb-gx-sm flex items-baseline justify-between gap-2">
          {" "}
          {/* R-F-06 控件上方 6px */}
          <label
            htmlFor={forId}
            className="text-gx-12 font-medium text-gx-text-secondary"
          >
            {label}
            {required && <span className="ml-0.5 text-gx-danger">*</span>}
            {optional && (
              <span className="ml-1 text-gx-11 font-regular text-gx-text-hint">选填</span>
            )}
          </label>
          {labelExtra && (
            <span className="shrink-0 text-gx-11 text-gx-text-tertiary">{labelExtra}</span>
          )}
        </div>
      )}

      {/* ② 控件区 */}
      <div
        className={clsx(
          "gx-field-ctl",
          CONTROL_SIZE_CLASS[size],
          // R-F-11 错误态：控件边框转 danger（特指度 0,1,1 高于 Tailwind 单类 0,1,0，无需 !important）
          hasError &&
            "[&>input]:border-gx-danger [&>select]:border-gx-danger [&>textarea]:border-gx-danger",
        )}
      >
        {children}
      </div>

      {/* ③ 错误 / 帮助区：R-F-12 固定 16px 预留，出现与消失都不改变布局高度 */}
      <div className="mt-1 h-4 text-gx-11 leading-4">
        {hasError ? (
          <span className="inline-flex items-center gap-1 text-gx-danger">
            <Icon name="alertCircle" size={11} className="shrink-0" />
            <span className="truncate" title={typeof error === "string" ? error : undefined}>
              {error}
            </span>
          </span>
        ) : help ? (
          <span className="block truncate text-gx-text-hint">{help}</span>
        ) : null}
      </div>
    </div>
  );
}

// ============ FormBanner：R-F-13 无法归属字段的错误 → 表单顶部横幅 ============

export function FormBanner({
  message,
  onDismiss,
  className,
}: {
  message: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-gx-banner="true"
      className={clsx(
        "flex items-start gap-2 rounded-gx-lg bg-gx-danger-bg px-3 py-2 text-gx-12 text-gx-danger",
        className,
      )}
    >
      <Icon name="alertCircle" size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭错误提示"
          className="shrink-0 rounded-gx-sm p-0.5 text-gx-danger hover:bg-gx-danger-bg"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

// ============ FormActions：R-F-15 / R-F-16 / R-F-17 ============

export interface FormActionsProps {
  /** R-F-15：页面表单左对齐，弹窗/抽屉右对齐 */
  align?: "left" | "right";
  /** R-F-17 主按钮禁用条件合并结果（必填未填全 / 有字段错误 / 提交中） */
  submitDisabled?: boolean;
  /** R-D-09 禁用必须带 title 说明原因 */
  submitDisabledReason?: string;
  submitting?: boolean;
  submitText?: string;
  onSubmit?: () => void;
  /** R-F-18 重置：仅在有改动时可用，回到初始值 */
  onReset?: () => void;
  resetEnabled?: boolean;
  onCancel?: () => void;
  cancelText?: string;
  /** 左侧附加内容（危险文字按钮 / 权限提示等），与右侧按钮组之间自动撑开 */
  leading?: ReactNode;
  /** 危险表单（注销 / 彻底删除）：主按钮改用 danger 底，其余尺寸与禁用逻辑不变 */
  danger?: boolean;
  className?: string;
}

export function FormActions({
  align = "right",
  submitDisabled = false,
  submitDisabledReason,
  submitting = false,
  submitText = "保存",
  onSubmit,
  onReset,
  resetEnabled = false,
  onCancel,
  cancelText = "取消",
  leading,
  danger = false,
  className,
}: FormActionsProps) {
  const disabled = submitDisabled || submitting;
  const reason = submitDisabledReason ?? (submitting ? "提交中，请稍候" : "请先完成必填项");
  const { variant } = useFormContext();
  // 未在 <Form> 内使用时按 align 入参；在 <Form> 内时由变体给出规范默认值
  const resolvedAlign = align;

  return (
    <div
      data-gx-actions="true"
      className={clsx(
        "flex items-center gap-2",
        resolvedAlign === "right" ? "justify-end" : "justify-start",
        className,
      )}
    >
      {leading && <div className="mr-auto">{leading}</div>}

      {onReset && (
        <button
          type="button"
          onClick={onReset}
          // R-F-18 仅在有改动时可用 + R-D-09 禁用带 title
          disabled={!resetEnabled || submitting}
          title={!resetEnabled ? "表单未改动" : undefined}
          className={clsx(
            "inline-flex h-8 items-center justify-center rounded-gx-lg bg-gx-control px-2.5",
            "text-gx-12 font-medium text-gx-text-secondary transition-colors",
            "hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          重置
        </button>
      )}

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className={clsx(
            "inline-flex h-8 items-center justify-center rounded-gx-lg bg-gx-control px-2.5",
            "text-gx-12 font-medium text-gx-text-secondary transition-colors",
            "hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {cancelText}
        </button>
      )}

      {onSubmit && (
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          // R-D-09：禁用必须说明原因；R-F-17 禁用只降透明度，不改底色
          title={disabled ? reason : undefined}
          data-gx-submit="true"
          data-variant={variant}
          className={clsx(
            "inline-flex h-8 min-w-[64px] items-center justify-center gap-1.5 rounded-gx-lg px-3",
            "text-gx-12 font-medium text-white transition-[filter,opacity] hover:brightness-95",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100",
            danger ? "bg-gx-danger" : "bg-gx-accent",
          )}
        >
          {submitting && (
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
            />
          )}
          {submitText}
        </button>
      )}
    </div>
  );
}

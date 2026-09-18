// apps/web/src/components/ui.tsx
// 基础 UI 组件库（v1 Shared/Theme.swift GXPrimaryButton / GXIconButton / GXEmptyState 等的 Web 移植）
// 所有组件只用 Tailwind token（gx-*），不硬编码颜色，保证与 v1 视觉同源

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import { Icon, type IconName } from "./icons";
import { FIELD_TYPE_COLOR } from "@gx/shared-types";
import { colors } from "@gx/design-tokens";

// ============ 字段类型 → 图标 ============

const FIELD_ICON_MAP: Record<string, IconName> = {
  singleLineText: "text",
  longText: "detail",
  richText: "detail",
  number: "number",
  currency: "circle",
  percent: "percent",
  duration: "clock",
  date: "calendar",
  datetime: "clock",
  checkbox: "check",
  singleSelect: "tags",
  multiSelect: "tags",
  email: "mail",
  url: "globe",
  phone: "phone",
  rating: "star",
  autoNumber: "hash",
  json: "formula",
  attachment: "paperclip",
  links: "link",
  lookup: "link",
  rollup: "sparkles",
  count: "hash",
  formula: "formula",
  createdTime: "clock",
  lastModifiedTime: "clock",
  createdBy: "user",
  lastModifiedBy: "user",
  tabs: "tags",
};

export function fieldIconName(type: string): IconName {
  return FIELD_ICON_MAP[type] ?? "field";
}

export function fieldColor(type: string): string {
  return FIELD_TYPE_COLOR[type as keyof typeof FIELD_TYPE_COLOR] ?? colors.textTertiary;
}

export function FieldIcon({ type, size = 14 }: { type: string; size?: number }) {
  return <Icon name={fieldIconName(type)} size={size} style={{ color: fieldColor(type) }} />;
}

// ============ 焦点环（R-D-09 焦点态：可见、走 gx-accent）============
// 全站控件共用同一条 focus ring，避免各写一套导致焦点态时隐时现。
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50 focus-visible:ring-offset-0";

// ============ Button ============

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  loading?: boolean;
  block?: boolean;
  /** R-D-09：禁用必须说明原因（渲染为 title） */
  disabledReason?: string;
}

// R-D-07 默认态取值；R-D-08 悬停：主按钮 brightness-95（不换色号），次按钮 / 行 #F1F5FB。
// R-D-06：页面内按钮一律无阴影（阴影只有浮层能用），故 primary 不再挂 shadow-sm。
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-gx-accent text-white hover:brightness-95",
  secondary: "border border-gx-border bg-gx-control text-gx-text-secondary hover:bg-gx-row-hover",
  ghost: "text-gx-text-secondary hover:bg-gx-row-hover",
  danger: "bg-gx-danger text-white hover:brightness-95",
};

// R-D-05 控件圆角 = 8（rounded-gx-lg）
const SIZE_CLASS = {
  sm: "h-7 px-2 text-gx-12 rounded-gx-lg gap-1",
  md: "h-8 px-3 text-gx-13 rounded-gx-lg gap-1.5",
  lg: "h-10 px-4 text-gx-14 rounded-gx-lg gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, block, className, children, disabled, disabledReason, title, ...rest },
  ref,
) {
  const isDisabled = !!disabled || !!loading;
  return (
    <button
      ref={ref}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      // R-D-09：禁用态必须说明原因；未给 reason 时沿用调用方自带 title，不静默丢提示
      title={title ?? (isDisabled ? disabledReason : undefined)}
      className={clsx(
        "inline-flex items-center justify-center font-medium select-none",
        // R-D-08 过渡 120ms
        "transition-[background-color,filter,opacity,box-shadow] duration-[120ms]",
        FOCUS_RING,
        // R-D-09 禁用：只降透明度到 .5 + not-allowed，**保持原色号**（不得灰色化、不得改底色）
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <>
          {/* R-D-10 加载：文案换成 12px spinner，保留按钮宽度（文字继续占位） */}
          <span
            aria-hidden="true"
            className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span className="opacity-0">{children}</span>
        </>
      ) : (
        <>
          {icon && <Icon name={icon} size={size === "sm" ? 13 : 15} />}
          {children}
        </>
      )}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  size?: number;
  active?: boolean;
  danger?: boolean;
  label?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, size = 16, active, danger, label, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      title={label}
      aria-label={label}
      className={clsx(
        // R-D-05 控件圆角 8；R-D-08 过渡 120ms
        "inline-flex h-7 w-7 items-center justify-center rounded-gx-lg transition-colors duration-[120ms]",
        FOCUS_RING,
        // R-D-09 禁用：opacity .5 保持原色，不改底色
        "disabled:cursor-not-allowed disabled:opacity-50",
        active ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary",
        danger && "hover:text-gx-danger",
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
});

// ============ 输入控件 ============

// ============ 输入控件（R-D-07~R-D-11 五态）============
//
// 统一五态：
//   默认  边框 #DFE3EA + 白底 + 主文本
//   悬停  边框加深到 #C3CAD6（不换底色）
//   焦点  边框 + 2px ring 走 gx-accent
//   禁用  opacity .5 + not-allowed，**保持原色号**（R-D-09），并带 title 说明原因
//   只读  去掉边框与底色、文字 #5B6785（R-D-11）；**用 readOnly 不用 disabled**——
//        disabled 会让内容无法选中复制、也无法聚焦，只读字段必须还能复制。
//
// 控件圆角一律 8（R-D-05 / C.4）。

/** 只读态样式：去边框、去底色，文字三级色，仍可选中复制、可聚焦 */
const READONLY_CLASS =
  "h-8 w-full rounded-gx-lg border-0 bg-transparent px-0 text-gx-13 text-gx-text-tertiary focus:outline-none";
/** 默认 / 悬停 / 焦点 / 禁用四态共享的框体样式 */
const FIELD_BASE_CLASS = clsx(
  "h-8 w-full rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 text-gx-13 text-gx-text-primary",
  "transition-colors duration-[120ms]",
  "hover:border-gx-border-strong",
  "focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent/50",
  "placeholder:text-gx-text-hint",
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-gx-border",
);

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** R-D-09 禁用原因（渲染为 title 提示） */
  disabledReason?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, disabledReason, title, ...rest },
  ref,
) {
  const readOnly = !!rest.readOnly;
  return (
    <input
      ref={ref}
      title={title ?? (rest.disabled ? disabledReason : undefined)}
      aria-readonly={readOnly || undefined}
      className={clsx(readOnly ? READONLY_CLASS : FIELD_BASE_CLASS, className)}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** R-D-09 禁用原因（渲染为 title 提示） */
  disabledReason?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, disabledReason, title, ...rest },
  ref,
) {
  const readOnly = !!rest.readOnly;
  return (
    <textarea
      ref={ref}
      title={title ?? (rest.disabled ? disabledReason : undefined)}
      aria-readonly={readOnly || undefined}
      className={clsx(
        readOnly
          ? "rounded-gx-lg border-0 bg-transparent px-0 text-gx-13 text-gx-text-tertiary focus:outline-none"
          : clsx(
              "w-full rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 py-1.5 text-gx-13",
              "text-gx-text-primary placeholder:text-gx-text-hint resize-y",
              "transition-colors duration-[120ms] hover:border-gx-border-strong",
              "focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent/50",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-gx-border",
            ),
        className,
      )}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: { value: string; label: string; disabled?: boolean }[];
  /** 分组渲染（optgroup）；与 options 二选一，groups 优先 */
  groups?: { label: string; options: { value: string; label: string; disabled?: boolean }[] }[];
  /**
   * R-D-11 只读：去边框去底色 + aria-readonly，**不用 disabled**。
   * 原生 <select> 无 readonly 属性，故本组件只做「视觉 + 语义」处理，
   * 是否允许改值由调用方决定是否传 onChange（不传即不会写回）。
   */
  readOnly?: boolean;
  /** R-D-09 禁用原因（渲染为 title 提示） */
  disabledReason?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, groups, className, readOnly, disabledReason, title, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      title={title ?? (rest.disabled ? disabledReason : undefined)}
      aria-readonly={readOnly || undefined}
      data-gx-readonly={readOnly ? "true" : undefined}
      className={clsx(
        "text-gx-13",
        readOnly
          ? "h-8 rounded-gx-lg border-0 bg-transparent px-0 text-gx-text-tertiary focus:outline-none"
          : clsx(
              "h-8 rounded-gx-lg border border-gx-border bg-gx-surface px-2 transition-colors duration-[120ms]",
              "text-gx-text-primary hover:border-gx-border-strong",
              "focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent/50",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-gx-border",
            ),
        className,
      )}
      {...rest}
    >
      {groups?.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
});

export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-gx-13 text-gx-text-primary">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-gx-accent"
      />
      {label}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-gx-13 text-gx-text-primary"
    >
      <span
        className={clsx(
          "relative h-5 w-9 rounded-full transition-colors",
          checked ? "bg-gx-accent" : "bg-gx-border-strong",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-gx-lg border border-gx-border bg-gx-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-gx-lg font-medium transition-colors duration-[120ms]",
            FOCUS_RING,
            size === "sm" ? "px-2 py-0.5 text-gx-11" : "px-2.5 py-1 text-gx-12",
            value === o.value
              ? "bg-gx-accent-bg text-gx-accent"
              : "text-gx-text-tertiary hover:bg-gx-row-hover",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ============ 展示 ============

/** 把单色 hex/rgb 解析为 rgb 数组 */
function hexToRgb(c: string): [number, number, number] | null {
  const m = c.trim().match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
/** 把单色加深 25% 用于文字（高对比） */
function darkenForText(rgb: [number, number, number]): string {
  const [r, g, b] = rgb;
  // HSL 亮度降到 35%
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const targetL = Math.max(0.2, l * 0.5);
  const k = targetL / Math.max(l, 0.01);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}
/** 背景 = 原色的 16% 不透明（明显但不抢戏） */
function tintBackground(rgb: [number, number, number]): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.16)`;
}

export function Badge({
  children,
  color,
  className,
  variant = "solid",
}: {
  children: ReactNode;
  color?: string;
  className?: string;
  /** soft = 浅色背景+深色文字（默认）；solid = 实色背景+白字 */
  variant?: "soft" | "solid";
}) {
  const rgb = color ? hexToRgb(color) : null;
  const style: React.CSSProperties | undefined = rgb
    ? variant === "solid"
      ? { backgroundColor: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.85)`, color: "#FFFFFF" }
      : { backgroundColor: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.18)`, color: darkenForText(rgb) }
    : { backgroundColor: "rgba(0,0,0,0.08)", color: "#444" };
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-gx-12 font-medium leading-none",
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-gx-border border-t-gx-accent"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * 统一空态（R-D-13 首次空态 / R-D-14 筛选空态）。
 *
 * 三要素齐备：图标 + 主文案 + 次文案 + 主行动入口——
 * 禁止只剩一句「暂无数据」的裸空态。
 *   first    列表 / 库 / 回收站首次为空：必须给一个主按钮（新建 / 导入）。
 *   filtered 搜索 / 筛选无结果：文案固定「没有匹配的内容」，给「清除筛选」，**不给新建按钮**。
 */
export function EmptyState({
  icon = "database",
  title,
  description,
  action,
  kind = "first",
  onClearFilters,
  className,
}: {
  icon?: IconName;
  title?: string;
  description?: string;
  action?: ReactNode;
  /** first = 首次空态（有行动入口）；filtered = 筛选空态（有清除筛选入口） */
  kind?: "first" | "filtered";
  /** 筛选空态的「清除筛选」回调 */
  onClearFilters?: () => void;
  className?: string;
}) {
  const filtered = kind === "filtered";
  const mainText = title ?? (filtered ? "没有匹配的内容" : "暂无数据");
  const subText = description ?? (filtered ? "换个关键词试试" : undefined);
  return (
    <div
      data-gx-empty={filtered ? "filtered" : "first"}
      className={clsx("flex flex-col items-center justify-center gap-3 px-6 py-16 text-center", className)}
    >
      {/* R-D-13 图标 24px / #8A94AC */}
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gx-bg text-gx-text-hint">
        <Icon name={filtered ? "search" : icon} size={24} />
      </div>
      {/* 主文案 14px/500 */}
      <div className="text-gx-14 font-medium text-gx-text-primary">{mainText}</div>
      {/* 次文案 12px / #8A94AC */}
      {subText && <div className="max-w-md text-gx-12 text-gx-text-hint">{subText}</div>}
      {!filtered && action}
      {filtered && onClearFilters && (
        <button
          type="button"
          onClick={onClearFilters}
          className={clsx(
            "inline-flex h-8 items-center justify-center rounded-gx-lg px-2 text-gx-12 font-medium",
            "text-gx-accent transition-colors duration-[120ms] hover:bg-gx-accent-bg",
            FOCUS_RING,
          )}
        >
          清除筛选
        </button>
      )}
    </div>
  );
}

export function FieldRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-gx-12 font-medium text-gx-text-secondary">{label}</label>
      {children}
      {hint && <div className="text-gx-11 text-gx-text-hint">{hint}</div>}
    </div>
  );
}

// ============ 浮层 ============

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 应用浮层一律 createPortal 到 document.body（z-index §2.5），脱离组件树内的画布堆叠上下文，
  // 避免被 .kb-canvas-wrap 内 z-60~80 的画布浮层遮挡（如 ShareModal 被嵌入编辑窗盖住）。
  return createPortal(
    <div className="fixed inset-0 gx-z-modal flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div
        className="relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-gx-xl"
        style={{ maxWidth: width }}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-gx-separator px-4 py-3">
            <div className="text-gx-14 font-semibold text-gx-text-primary">{title}</div>
            <IconButton icon="close" label="关闭" onClick={onClose} />
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-gx-separator px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 下拉面板：点击外部自动关闭 */
export function Popover({
  open,
  onClose,
  children,
  align = "left",
  width,
  className,
  fixed = false,
  anchorEl,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  width?: number;
  className?: string;
  /**
   * fixed 模式：portal 到 body，按触发锚点（Popover 的父定位元素）做视口定位。
   * 用于弹层祖先存在 overflow:auto/hidden（如深层级树节点）会裁剪 absolute 弹层的场景。
   * 自动防止右/下溢出，并在页面滚动时实时跟随。
   */
  fixed?: boolean;
  /** fixed 模式下的定位锚点（通常是触发按钮）；不传则回退到弹层父元素 */
  anchorEl?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延迟一帧，避免触发按钮的 click 立即关闭
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // fixed 模式：依据传入锚点（或弹层父定位元素）计算视口坐标
  useLayoutEffect(() => {
    if (!open || !fixed) return;
    const el = ref.current;
    if (!el) return;
    const anchor = anchorEl ?? el.parentElement ?? null;
    const compute = () => {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const w = width ?? el.offsetWidth ?? 160;
      const estH = el.offsetHeight || 0;
      let left = align === "right" ? r.right - w : r.left;
      const margin = 8;
      // 水平防溢出
      left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
      let top = r.bottom + 4;
      // 下方放不下则翻到锚点上方
      if (estH && top + estH > window.innerHeight - margin) {
        const upTop = r.top - estH - 4;
        if (upTop >= margin) top = upTop;
      }
      setPos({ top, left });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, fixed, align, width, anchorEl]);

  if (!open) return null;

  const cls = clsx(
    "overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface shadow-gx-lg",
    // fixed 模式 portal 到 body，归应用浮层 popover(900)；absolute 模式保持容器内局部 z-40
    fixed ? "fixed gx-z-popover" : "absolute top-full z-40 mt-1",
    !fixed && (align === "right" ? "right-0" : "left-0"),
    className,
  );

  const node = (
    <div
      ref={ref}
      className={cls}
      style={{
        width,
        ...(fixed && pos ? { top: pos.top, left: pos.left } : {}),
      }}
    >
      {children}
    </div>
  );

  return fixed ? createPortal(node, document.body) : node;
}

export interface MenuItemProps {
  icon?: IconName;
  label: ReactNode;
  description?: string;
  onClick?: () => void;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** R-D-09 禁用必须说明原因（渲染为 title） */
  disabledReason?: string;
  shortcut?: string;
}

export function MenuItem({
  icon,
  label,
  description,
  onClick,
  danger,
  active,
  disabled,
  disabledReason,
  shortcut,
  title,
}: MenuItemProps & { title?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title ?? (disabled ? disabledReason : undefined)}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={clsx(
        "flex w-full items-start gap-2 px-3 py-1.5 text-left text-gx-13 transition-colors duration-[120ms]",
        // R-D-09 禁用：opacity .5 保持原色 + not-allowed（菜单项此前的 .4 与规范不一致）
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gx-accent/50",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        danger ? "text-gx-danger hover:bg-gx-danger-bg" : "text-gx-text-primary hover:bg-gx-row-hover",
        active && "bg-gx-accent-bg text-gx-accent",
      )}
    >
      {icon && <Icon name={icon} size={14} className="mt-0.5 flex-shrink-0" />}
      <span className="flex-1">
        <span className="block truncate">{label}</span>
        {description && <span className="block text-gx-11 text-gx-text-hint">{description}</span>}
      </span>
      {shortcut && <span className="text-gx-11 text-gx-text-hint">{shortcut}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-gx-separator" />;
}

/** 菜单容器（配合 MenuItem 使用） */
export function Menu({ children, width = 200 }: { children: ReactNode; width?: number }) {
  return (
    <div className="py-1" style={{ width }}>
      {children}
    </div>
  );
}

// ============ ContextMenu（受控浮层菜单）============
// 用于文档编辑器右键菜单。坐标基于视口；越界自动回弹到可视区内。
// items 形如：
//   - { kind: 'item', label, icon?, danger?, disabled?, onClick, shortcut? }
//   - { kind: 'divider' }
//   - { kind: 'submenu', label, icon?, items: [...] }    // 一级子菜单（可选）
//   - { kind: 'custom', className?, render: ({ onClose }) => ReactNode }  // 自定义内容（颜色选择器等）
export type ContextMenuItem =
  | {
      kind: "item";
      label: ReactNode;
      icon?: IconName;
      danger?: boolean;
      disabled?: boolean;
      active?: boolean;
      onClick?: () => void;
      shortcut?: string;
    }
  | { kind: "divider" }
  | {
      kind: "submenu";
      label: ReactNode;
      icon?: IconName;
      items: ContextMenuItem[];
    }
  | {
      kind: "custom";
      className?: string;
      render: (helpers: { onClose: () => void }) => ReactNode;
    };

export function ContextMenu({
  open,
  x,
  y,
  items,
  onClose,
  width = 220,
  containerRef,
  menuClassName,
}: {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  width?: number;
  /**
   * 外部锚点 ref —— 当 hover 到该元素（或其内部）时，菜单不会被视为"外部点击"关闭。
   * 用于 ContextSubmenu：把 trigger button 作为锚点，子菜单打开期间鼠标在 trigger 上也保持打开。
   */
  containerRef?: React.RefObject<HTMLElement>;
  /**
   * 追加到菜单根节点的 className。画布场景必须传 "plait-board-attached"——
   * 否则点击菜单项的 pointerup 命中 plait globalPointerUp 的"板外点击"判定，
   * 在 onClick 执行前清空画布选区（图层/样式命令读到空选区而静默失效）。
   */
  menuClassName?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // 越界回弹：测量实际宽高后修正 left/top
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useEffect(() => {
    if (!open) return;
    setPos({ left: x, top: y });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    // 等 DOM 渲染后测量
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
      if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
      setPos({ left, top });
    }, 0);
    return () => clearTimeout(t);
  }, [open, x, y, items]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const insideMenu = ref.current && ref.current.contains(e.target as Node);
      const insideAnchor = containerRef?.current && containerRef.current.contains(e.target as Node);
      if (!insideMenu && !insideAnchor) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延迟一帧挂载，避免触发右键的 mouseup 立即关闭
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, containerRef]);

  if (!open) return null;

  // 应用浮层：portal 到 document.body，归 popover(900)；定位仍用视口坐标 fixed（计算逻辑不变）
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-context-menu="true"
      style={{ position: "fixed", left: pos.left, top: pos.top, width }}
      className={clsx("gx-z-popover overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface shadow-gx-lg", menuClassName)}
    >
      <div className="py-1">
        {items.map((it, i) => {
          if (it.kind === "divider") {
            return <div key={i} className="my-1 h-px bg-gx-separator" />;
          }
          if (it.kind === "submenu") {
            return (
              <ContextSubmenu key={i} label={it.label} icon={it.icon} items={it.items} onClose={onClose} />
            );
          }
          if (it.kind === "custom") {
            // 自定义内容（如颜色选择器）：不受 items 列表通用样式约束，按 render 函数自定义
            return (
              <div key={i} className={it.className}>
                {it.render({ onClose })}
              </div>
            );
          }
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={(e) => {
                e.stopPropagation();
                if (it.disabled) return;
                it.onClick?.();
                onClose();
              }}
              className={clsx(
                "flex w-full items-start gap-2 px-3 py-1.5 text-left text-gx-13 transition-colors duration-[120ms]",
                // R-D-09 禁用统一 opacity .5；R-D-08 行 hover 统一 #F1F5FB
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gx-accent/50",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                it.danger
                  ? "text-gx-danger hover:bg-gx-danger-bg"
                  : "text-gx-text-primary hover:bg-gx-row-hover",
                it.active && "bg-gx-accent-bg text-gx-accent",
              )}
            >
              {it.icon && <Icon name={it.icon} size={14} className="mt-0.5 flex-shrink-0" />}
              <span className="flex-1 truncate">{it.label}</span>
              {it.shortcut && <span className="text-gx-11 text-gx-text-hint">{it.shortcut}</span>}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 子菜单：用 fixed 定位 + 全局 mousemove 坐标判定保持 hover 状态。
 *
 * 旧实现的问题：父项 <div> 用 onMouseEnter/Leave 控 open，但子菜单 fixed 定位在父容器
 * bounding box 之外（left-full），鼠标从父项滑向子菜单会穿过 1px 间隙，DOM 事件上
 * 算"离开父项" → 立即 setOpen(false) → 子菜单闪烁消失。
 *
 * 新实现：
 * 1) 子菜单位置用 useLayoutEffect 计算（trigger.right + 4，或视口右越界时改左侧）
 * 2) 全局 mousemove 监听，鼠标落在 trigger bbox ∪ submenu bbox 内 → cancelClose()，否则 → scheduleClose(150ms)
 * 3) ContextMenu 接受 containerRef 参数，把 trigger 算作"内部锚点"，子菜单 mousedown outside 不会误关
 * 4) 子菜单自己的 onMouseEnter 也 cancelClose 作为冗余保护
 */
function ContextSubmenu({
  label,
  icon,
  items,
  onClose,
}: {
  label: ReactNode;
  icon?: IconName;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 150);
  };

  // 打开后计算子菜单位置（视口右越界自动翻到左侧）
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 子菜单宽度需容纳 ColorPicker 完整面板（260px 内容 + 安全余量）
    const menuWidth = 280;
    const gap = 4;
    let x = r.right + gap;
    if (x + menuWidth + 8 > window.innerWidth) {
      x = Math.max(8, r.left - menuWidth - gap);
    }
    setPos({ x, y: r.top });
  }, [open]);

  // 全局 mousemove 坐标判定
  // 关键：用 submenuRef 精确判断"鼠标在当前子菜单内"（而不是任意 context-menu 容器内），
  // 否则鼠标移到 sibling submenu 的 trigger 时，因 trigger 位于主菜单的 [data-context-menu] 容器内，
  // 会误判 inSubmenu=true → cancelClose()，导致 isOverSibling 的立即关闭永远走不到。
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      const tr = triggerRef.current?.getBoundingClientRect();
      const inTrigger =
        tr !== undefined &&
        e.clientX >= tr.left &&
        e.clientX <= tr.right &&
        e.clientY >= tr.top &&
        e.clientY <= tr.bottom;

      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      // 精确判断"鼠标在当前子菜单内"：用 ref.contains，避免误中主菜单或其他兄弟子菜单
      const inCurrentSubmenu =
        target !== null && submenuRef.current !== null && submenuRef.current.contains(target);

      // 鼠标进入同级 submenu 的 trigger（aria-haspopup="true"）→ 立即关闭本 submenu
      const siblingTrigger = target?.closest('button[aria-haspopup="true"]');
      const isOverSibling =
        siblingTrigger !== undefined && siblingTrigger !== triggerRef.current;

      if (inTrigger || inCurrentSubmenu) {
        cancelClose();
      } else if (isOverSibling) {
        setOpen(false);
        cancelClose();
      } else {
        scheduleClose();
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelClose();
    };
  }, [open, pos.x, pos.y]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="true"
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        // 注意：故意不在这里挂 onMouseLeave={scheduleClose}。
        // 原写法会在用户首次直接 hover 一个 submenu trigger 时（React 首次 useLayoutEffect
        // 计算位置 → setPos → re-render → ContextMenu 内部 useState 还没同步 → 第 1 次 paint
        // 时子菜单在 (0,0) 闪现 → 整个 commit 期间 trigger 的 layout box 可能微移，浏览器对
        // 同一个 hover 派发 mouseleave），立即设一个 150ms 不可逆关闭定时器。首次直接选时没有
        // 兄弟 submenu 的 mousemove 监听在抢跑帮它重置定时器，定时器到期就关，子菜单瞬间消失。
        // 关闭策略完全交给下面的全局 mousemove 监听：只要鼠标还在 trigger / 当前 submenu /
        // 另一个 sibling trigger 上，就保持打开；否则 scheduleClose()。
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-gx-13 text-gx-text-primary hover:bg-gx-bg"
      >
        {icon && <Icon name={icon} size={14} className="mt-0.5 flex-shrink-0" />}
        <span className="flex-1 truncate">{label}</span>
        <Icon name="chevronRight" size={12} className="mt-0.5 text-gx-text-hint" />
      </button>
      {open && (
        <div ref={submenuRef}>
          <ContextMenu
            open
            x={pos.x}
            y={pos.y}
            items={items}
            onClose={() => {
              cancelClose();
              setOpen(false);
              onClose();
            }}
            width={280}
            containerRef={triggerRef}
          />
        </div>
      )}
    </>
  );
}

// ============ Toast ============
// R-D-20 统一右下角（移动底部居中）· 圆角 8 · 最大宽度 360 · 同时最多 3 条
// R-D-21 成功默认不带标题，只说结果且带对象名
// R-D-22 删除 / 归档类成功 toast 必须带「撤销」，保留 6 秒
// 3.4 反馈矩阵：成功 2.5s / 可撤销 6s / 系统级失败 4s 且可展开详情

export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  /** 按钮文案（R-D-24 同款要求：具体动词，如「撤销」） */
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  /** 停留时长（ms）。缺省：带 action → 6000；error → 4000；其余 → 2500 */
  duration?: number;
  /** R-D-22 可撤销操作的「撤销」按钮 */
  action?: ToastAction;
  /** 失败 · 系统级：可展开的详情原文（服务端错误明细等） */
  detail?: string;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  duration: number;
  action?: ToastAction;
  detail?: string;
}

/** R-D-20 同屏最多 3 条 */
export const TOAST_MAX = 3;
/** R-D-22 撤销窗口 6 秒 */
export const TOAST_UNDO_MS = 6000;
/** 失败 · 系统级 4 秒 */
export const TOAST_ERROR_MS = 4000;
/** 成功 · 无需后续 2.5 秒 */
export const TOAST_SUCCESS_MS = 2500;

let toastSeq = 0;
const toastListeners = new Set<(items: ToastItem[]) => void>();
let toastItems: ToastItem[] = [];

function emitToast() {
  for (const l of toastListeners) l([...toastItems]);
}

/**
 * 当前存活的 toast 快照（只读副本）。供单测与调试断言「最多 3 条 / 撤销 6s / 错误 4s」。
 */
export function toastSnapshot(): {
  id: number;
  kind: ToastKind;
  message: string;
  duration: number;
  hasAction: boolean;
}[] {
  return toastItems.map((t) => ({
    id: t.id,
    kind: t.kind,
    message: t.message,
    duration: t.duration,
    hasAction: !!t.action,
  }));
}

/** 关闭指定 toast（撤销 / 手动关闭后立刻收起，不等计时器） */
export function dismissToast(id: number) {
  const next = toastItems.filter((t) => t.id !== id);
  if (next.length === toastItems.length) return;
  toastItems = next;
  emitToast();
}

/**
 * 弹出 toast。向后兼容旧签名 `toast(message, "success")`；
 * 新签名 `toast(message, { kind, action, detail, duration })`。
 * @returns 该条 toast 的 id（可用于提前 dismiss）
 */
export function toast(message: string, kindOrOptions: ToastKind | ToastOptions = "info"): number {
  const opt: ToastOptions =
    typeof kindOrOptions === "string" ? { kind: kindOrOptions } : kindOrOptions;
  const kind = opt.kind ?? "info";
  const id = ++toastSeq;
  const duration =
    opt.duration ?? (opt.action ? TOAST_UNDO_MS : kind === "error" ? TOAST_ERROR_MS : TOAST_SUCCESS_MS);
  // R-D-20 超出 3 条时挤掉最旧的一条（堆叠折叠）
  toastItems = [
    ...toastItems,
    { id, kind, message, duration, action: opt.action, detail: opt.detail },
  ].slice(-TOAST_MAX);
  emitToast();
  if (duration > 0) {
    // 用全局 setTimeout（非 window.*）：SSR/单测的 node 环境同样可用
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

const TOAST_TONE: Record<ToastKind, string> = {
  success: "bg-gx-success text-white",
  error: "bg-gx-danger text-white",
  info: "bg-gx-text-primary text-white",
};

const TOAST_ICON: Record<ToastKind, IconName> = {
  success: "check",
  error: "alertCircle",
  info: "sparkles",
};

function ToastCard({ item }: { item: ToastItem }) {
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <div
      data-gx-toast={item.kind}
      className={clsx(
        "pointer-events-auto flex w-full max-w-[360px] items-start gap-2 rounded-gx-lg px-3 py-2",
        "text-gx-13 shadow-gx-lg sm:w-[360px]",
        TOAST_TONE[item.kind],
      )}
    >
      <Icon name={TOAST_ICON[item.kind]} size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {/* R-D-21 成功 toast 默认不带标题，只说结果且带对象名 */}
        <div className="break-words">{item.message}</div>
        {item.detail && (
          <>
            <button
              type="button"
              onClick={() => setDetailOpen((v) => !v)}
              className={clsx(
                "mt-1 text-gx-11 underline decoration-white/50 underline-offset-2",
                "transition-opacity duration-[120ms] hover:decoration-white",
              )}
            >
              {detailOpen ? "收起详情" : "展开详情"}
            </button>
            {detailOpen && (
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-gx-11 text-white/90">
                {item.detail}
              </pre>
            )}
          </>
        )}
      </div>
      {/* R-D-22 删除 / 归档类成功 toast 必须带「撤销」，窗口 6s */}
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            dismissToast(item.id);
          }}
          className={clsx(
            "shrink-0 rounded-gx-lg px-1.5 py-0.5 text-gx-12 font-medium underline",
            "decoration-white/60 underline-offset-2 transition-colors duration-[120ms]",
            "hover:bg-white/15 hover:decoration-white",
            FOCUS_RING,
          )}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => dismissToast(item.id)}
        className={clsx(
          "shrink-0 rounded-gx-lg p-0.5 text-white/80 transition-colors duration-[120ms] hover:bg-white/15 hover:text-white",
          FOCUS_RING,
        )}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    toastListeners.add(setItems);
    // 挂载时同步一次：组件可能在 toast 弹出后才挂载（如懒加载路由）
    setItems(toastItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="操作反馈"
      className={clsx(
        // 移动：底部居中；桌面（≥640）：右下角
        "pointer-events-none fixed inset-x-4 bottom-4 gx-z-toast flex flex-col items-center gap-2",
        "sm:inset-x-auto sm:bottom-6 sm:right-6 sm:items-end",
      )}
    >
      {items.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  );
}

// ============ 色板 ============

export const COLOR_PALETTE = [
  "#D3F0E4",
  "#F7E1D7",
  "#FBDDDD",
  "#DCE7F5",
  "#E5DEEB",
  "#FBE9D0",
  "#E1F0E8",
  "#F0E4D7",
  "#CFE3F5",
  "#F3D9E7",
  "#DDF3E0",
  "#FBE7C6",
];

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={clsx(
            "h-6 w-6 rounded-full border-2 transition-transform hover:scale-110",
            value === c ? "border-gx-accent" : "border-transparent",
          )}
          style={{ backgroundColor: c }}
          aria-label={c}
        />
      ))}
    </div>
  );
}

// apps/web/src/components/settings-controls.tsx
// 字段设置面板专用的「轻量设置控件」：
//   DropdownSelect   —— 全宽大下拉（纵向堆叠，替代横排小按钮/原生小 select）
//   DashedSetupButton —— 虚线框「设置…」按钮（未配置时的入口）
//   SoftActionButton  —— 浅灰底主色文字按钮（已配置后的编辑入口 / 公式入口）
//   SettingLabel      —— 带问号提示的设置项标题
// 设计语言：纵向堆叠、大点击区、弱边框、留白充足，避免粗壮的横排碎按钮。
// 说明：DropdownSelect 以原生 <select> 打底（收起态视觉对齐参考截图，展开用系统菜单），
// 从而在 Modal/抽屉的滚动容器里也不会被裁剪，零浮层定位风险。

import { type ReactNode } from "react";
import { clsx } from "clsx";
import { Icon, type IconName } from "./icons";

// ============ 全宽大下拉（原生 select 打底） ============

export interface DropdownOption {
  value: string;
  label: ReactNode;
  /** 置灰不可选（如依赖未满足） */
  disabled?: boolean;
}

/** 分组选项：渲染为 <optgroup> */
export interface DropdownGroup {
  label: string;
  options: DropdownOption[];
}

export function DropdownSelect({
  value,
  options,
  groups,
  onChange,
  placeholder = "请选择",
  className,
  disabled,
}: {
  value: string;
  options?: DropdownOption[];
  /** 分组选项（与 options 二选一；分组内仍可被选中） */
  groups?: DropdownGroup[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const flat = groups ? groups.flatMap((g) => g.options) : (options ?? []);
  // 当前 value 是否命中一个有效（非置灰）选项；否则视为占位态
  const hasValue = flat.some((o) => o.value === value && !o.disabled);

  return (
    <div className={clsx("relative", className)}>
      <select
        value={hasValue ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          "h-10 w-full appearance-none rounded-gx-md border border-gx-border bg-gx-surface pl-3 pr-9 text-gx-14",
          "focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent-bg",
          "disabled:cursor-not-allowed disabled:opacity-50",
          hasValue ? "text-gx-text-primary" : "text-gx-text-hint",
        )}
      >
        {/* 占位项（不可选） */}
        {!hasValue && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {groups
          ? groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled} className="text-gx-text-primary">
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))
          : (options ?? []).map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled} className="text-gx-text-primary">
                {o.label}
              </option>
            ))}
      </select>
      <Icon
        name="chevronDown"
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gx-text-tertiary"
      />
    </div>
  );
}

// ============ 虚线框「设置…」按钮（未配置入口） ============

export function DashedSetupButton({
  label,
  icon = "settings",
  onClick,
  className,
}: {
  label: ReactNode;
  icon?: IconName;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex w-full items-center justify-center gap-1.5 rounded-gx-md border border-dashed border-gx-border-strong",
        "bg-gx-surface px-3 py-2.5 text-gx-14 text-gx-text-secondary transition-colors",
        "hover:border-gx-accent hover:bg-gx-accent-bg/40 hover:text-gx-accent",
        className,
      )}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
}

// ============ 浅底主色文字按钮（已配置 / 公式入口） ============

export function SoftActionButton({
  label,
  icon,
  onClick,
  className,
}: {
  label: ReactNode;
  icon?: IconName;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex w-full items-center justify-center gap-1.5 rounded-gx-md bg-gx-bg px-3 py-2.5",
        "text-gx-14 font-medium text-gx-accent transition-colors hover:bg-gx-accent-bg",
        className,
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      <span>{label}</span>
    </button>
  );
}

// ============ 设置项标题（带问号提示） ============

export function SettingLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-gx-13 font-semibold text-gx-text-primary">{children}</span>
      {hint && (
        <span title={hint}>
          <Icon name="help" size={14} className="cursor-help text-gx-text-hint" />
        </span>
      )}
    </div>
  );
}


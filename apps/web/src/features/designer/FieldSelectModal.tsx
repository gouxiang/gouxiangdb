// apps/web/src/features/designer/FieldSelectModal.tsx
// 子表格字段选择弹窗（用户反馈：子表格「显示字段」「选择弹窗可见字段」字段过多时
// 复选框网格把页面拉得极长）。搜索 + 多选列表 + 批量确认取代内联复选框网格。
//
// 交互契约：
//   - 打开时快照当前值：勾选只改临时 state，「确定」才 onChange 写回；
//     「取消」/遮罩/Esc 放弃。
//   - value=null 表示「默认」：按 defaultFieldIds 预勾选并显示提示横幅，
//     「确定」落为显式数组；「恢复默认」直接 onChange(null) 并关闭。
//   - 候选字段由调用方传入（两处面板各自的 targetFields，过滤/排序口径与原网格完全一致）。
//
// 浮层：createPortal 到 body、gx-z-modal(800)、样式只用 gx-* token；不新增依赖。

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FieldDTO } from "@gx/shared-types";
import { FIELD_TYPE_LABEL } from "@gx/shared-types";
import { COLOR_PALETTE, FieldIcon, Popover } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ColorPicker } from "../../components/ColorPicker";

/**
 * 新增选项的统一默认起始色（#693：不再按 COLOR_PALETTE 下标随机轮转）。
 * 两个设置面板（FieldEditorSheet / FieldSettingsPanel）共用此常量。
 */
export const OPTION_DEFAULT_COLOR = COLOR_PALETTE[0]!;

/**
 * 选项颜色入口（#693）：圆点不再点击循环变色，点击打开锚定圆点的 portal popover，
 * 内嵌 components/ColorPicker（完整路径引用，避免与 ui.tsx L1479 同名 ColorPicker 冲突）。
 * onChange 实时写回 option.color；选「无背景」回落统一默认色（选项色不允许为空）。
 * 两个设置面板共用此组件，不复制第二套。
 */
export function OptionColorButton({
  color,
  onChange,
}: {
  color: string;
  onChange: (hex: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="设置选项颜色"
        title="设置颜色"
        className="h-6 w-6 flex-shrink-0 rounded-full border border-gx-border"
        style={{ backgroundColor: color }}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        fixed
        anchorEl={anchorRef.current}
        width={240}
      >
        <ColorPicker
          mode="bg"
          current={color}
          onClose={() => setOpen(false)}
          onChange={(hex) => onChange(hex ?? OPTION_DEFAULT_COLOR)}
        />
      </Popover>
    </>
  );
}

/**
 * 子表格默认字段集：未配置（null/空）时的回退口径。
 * 与 DetailLayout SubtablePanel 的运行时回退一致——对面表可显示字段前 4 个。
 * 抽成纯函数供弹窗预勾选与单测复用，避免第二套口径。
 */
export function defaultFieldIds(fields: readonly FieldDTO[]): string[] {
  return fields.slice(0, 4).map((f) => f.id as string);
}

/** 搜索过滤：大小写不敏感按字段名匹配；空查询返回全部。 */
export function filterFields(fields: readonly FieldDTO[], query: string): FieldDTO[] {
  const q = query.trim().toLowerCase();
  return q === "" ? [...fields] : fields.filter((f) => f.name.toLowerCase().includes(q));
}

/** 确定写回：按候选字段顺序（而非 Set 迭代序）输出已选 id。 */
export function orderedSelectedIds(
  fields: readonly FieldDTO[],
  checked: ReadonlySet<string>,
): string[] {
  return fields.filter((f) => checked.has(f.id as string)).map((f) => f.id as string);
}

export interface FieldSelectModalProps {
  /** 候选字段（调用方已按 isReferenceableType 等规则过滤，顺序即展示顺序）。 */
  fields: readonly FieldDTO[];
  /** 当前已选字段 id；null = 默认（走 defaultFieldIds）。 */
  value: readonly string[] | null;
  /** 确定（显式数组）或恢复默认（null）时回调。 */
  onChange: (next: string[] | null) => void;
  onClose: () => void;
  /** 头部标题，如「选择子表格显示字段」。 */
  title: string;
  /** 副标题：对面表名。 */
  subtitle: string;
  /** 搜索框占位文案（可选）。 */
  searchPlaceholder?: string;
}

function FieldSelectModal({
  fields,
  value,
  onChange,
  onClose,
  title,
  subtitle,
  searchPlaceholder = "搜索字段名",
}: FieldSelectModalProps) {
  // 打开快照：是否为默认态 + 临时勾选集。null 按默认集预勾选。
  const [startedDefault] = useState(value === null);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(value === null ? defaultFieldIds(fields) : value),
  );
  const [query, setQuery] = useState("");

  // Esc 放弃
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 搜索：大小写不敏感按字段名过滤
  const filtered = useMemo(() => filterFields(fields, query), [fields, query]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // fields 顺序即勾选写回顺序（与对面表字段序一致）
  const confirm = () => {
    onChange(orderedSelectedIds(fields, checked));
    onClose();
  };
  const resetDefault = () => {
    onChange(null);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 gx-z-modal flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-gx-xl"
      >
        {/* 头部：标题 + 对面表名 */}
        <div className="border-b border-gx-separator px-4 py-3">
          <div className="text-gx-14 font-semibold text-gx-text-primary">{title}</div>
          <div className="mt-0.5 truncate text-gx-11 text-gx-text-secondary">
            来自数据表：{subtitle}
          </div>
        </div>

        {/* 默认态提示横幅：勾选后确定将变为自定义 */}
        {startedDefault && (
          <div className="border-b border-gx-separator bg-gx-accent-bg/50 px-4 py-2 text-gx-11 text-gx-accent">
            当前为默认选择，勾选并确定后将变为自定义
          </div>
        )}

        {/* 搜索框 */}
        <div className="px-4 pt-3">
          <div className="flex items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-bg px-2.5 py-1.5">
            <Icon name="search" size={13} className="text-gx-text-hint" />
            <input
              autoFocus
              value={query}
              placeholder={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-gx-text-hint hover:text-gx-text-primary"
                aria-label="清除搜索"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        </div>

        {/* 多选列表：独立滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {filtered.length === 0 ? (
            <div className="px-2 py-8 text-center text-gx-12 text-gx-text-hint">
              {query.trim() ? "没有匹配的字段" : "没有可选字段"}
            </div>
          ) : (
            <ul className="flex flex-col">
              {filtered.map((f) => {
                const id = f.id as string;
                const on = checked.has(id);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      aria-pressed={on}
                      className="flex w-full items-center gap-2.5 rounded-gx-lg px-2 py-1.5 text-left transition-colors hover:bg-gx-bg"
                    >
                      <span
                        className={
                          "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border " +
                          (on
                            ? "border-gx-accent bg-gx-accent text-white"
                            : "border-gx-border bg-gx-surface")
                        }
                      >
                        {on && <Icon name="check" size={11} />}
                      </span>
                      <FieldIcon type={f.type} size={13} />
                      <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-primary">
                        {f.name}
                      </span>
                      <span className="flex-shrink-0 rounded-gx-sm bg-gx-bg px-1.5 py-0.5 text-gx-11 text-gx-text-hint">
                        {FIELD_TYPE_LABEL[f.type]}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 底部：左 已选/恢复默认；右 取消/确定 */}
        <div className="flex items-center justify-between gap-2 border-t border-gx-separator px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-gx-12 text-gx-text-secondary">已选 {checked.size} 项</span>
            <button
              type="button"
              onClick={resetDefault}
              className="rounded-gx-sm text-gx-12 text-gx-accent transition-colors hover:bg-gx-accent-bg"
            >
              恢复默认
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-gx-lg border border-gx-border bg-gx-surface px-3 py-1.5 text-gx-12 text-gx-text-secondary transition-colors hover:bg-gx-bg"
            >
              取消
            </button>
            <button
              type="button"
              onClick={confirm}
              className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-12 text-white transition-colors hover:brightness-105"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default FieldSelectModal;
export { FieldSelectModal };

/**
 * 摘要行：取代内联复选框网格。
 * 空（默认态）显示「默认」；有值显示「已选 N 项 · 前2个字段名」+「选择」按钮。
 */
export function FieldSelectSummary({
  fields,
  ids,
  onSelect,
}: {
  fields: readonly FieldDTO[];
  ids: readonly string[];
  onSelect: () => void;
}) {
  const names = useMemo(() => {
    const byId = new Map(fields.map((f) => [f.id as string, f.name]));
    return ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
  }, [fields, ids]);

  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 py-1.5 text-gx-12">
        <Icon name="list" size={13} className="shrink-0 text-gx-text-hint" />
        {ids.length === 0 ? (
          <span className="text-gx-text-hint">默认</span>
        ) : (
          <span className="min-w-0 truncate text-gx-text-secondary">
            已选 {ids.length} 项
            {names.length > 0 && (
              <span className="text-gx-text-hint">
                {" "}· {names.slice(0, 2).join("、")}{names.length > 2 ? " 等" : ""}
              </span>
            )}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onSelect}
        disabled={fields.length === 0}
        className="flex-shrink-0 rounded-gx-lg border border-gx-border bg-gx-surface px-3 py-1.5 text-gx-12 text-gx-accent transition-colors hover:bg-gx-accent-bg disabled:opacity-40"
      >
        选择
      </button>
    </div>
  );
}

// apps/web/src/components/interaction.tsx
// 阶段 4 · 交互路径与通用边界（UI-SPEC v1.0 §4.1~§4.6 + R-D-15 / R-D-27）
//
// 规范锚点：
//   R-I-01 筛选 / 分组 / 排序走「工具栏按钮 + 气泡面板」，规则可单条删除、一键清空
//   R-I-02 分页默认无限滚动 + 底部「已加载 N 条」；>5000 或用户切过页码时改用分页器
//   R-I-03 搜索框在工具栏右侧（宽 170），输入防抖 300ms，搜索期间保留旧结果并置灰
//   R-I-04 筛选生效后空结果走 R-D-14（筛选空态），并在工具栏显示「筛选中」徽标
//   R-I-05 列宽拖拽最小 80px
//   R-I-12 多选后工具栏**切换为批量条**：「已选 N 条」+ 操作 + 取消选择，原工具栏隐藏
//   R-I-13 表头复选框三态：未选 / 部分选（横线）/ 全选；「全选」只作用于当前页，
//          并提供「选择全部 N 条」文字链接
//   R-I-14 批量操作前展示影响条数
//   R-I-21 状态类字段用胶囊标签（圆角 9999 / 11px / 语义色底 + 深一档字）
//   R-I-22 状态流转用横向步骤条（当前态高亮 accent，已完成打勾，未开始 text-hint）
//   R-I-26 所有写操作按钮点击后立即禁用并显示 spinner，防止双击重复提交
//   R-I-27 网络超时（>15s）提示「请求超时，请重试」，不自动重试写操作
//   R-I-29 长文本一律截断 + title 全文，禁止 overflow:hidden 无提示截断
//   R-D-15 加载态 ≥300ms 才显示（避免「空白→骨架」闪烁）
//   R-D-27 局部刷新（翻页、筛选）不用骨架屏，保留旧内容 + 内容区 opacity .6
//
// 全部使用 gx-* token 与 components/icons.tsx 自建图标；不新增依赖、不裸 fetch、不写死 hex。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { clsx } from "clsx";
import { Button, FOCUS_RING, toast, darkenForText } from "./ui";
import { Icon, type IconName } from "./icons";

// ============================================================
// 常量（规范取值，集中放置便于单测断言）
// ============================================================

/** R-D-15 加载态最小显示门槛：低于 300ms 一律不显示，避免闪一下骨架屏。 */
export const LOADING_DELAY_MS = 300;
/** R-I-03 搜索输入防抖窗口。 */
export const SEARCH_DEBOUNCE_MS = 300;
/** R-I-03 工具栏搜索框宽度（附录 B「搜索框 170×32」）。 */
export const SEARCH_BOX_W = 170;
/** R-I-05 列宽拖拽下限。 */
export const MIN_COL_WIDTH = 80;
/** R-I-02 无限滚动默认口径；超过此条数或用户切过页码时改用分页器。 */
export const PAGINATE_THRESHOLD = 5000;
/** R-I-27 写操作超时门槛（秒→ms）。 */
export const WRITE_TIMEOUT_MS = 15000;

// ============================================================
// R-D-15 · 延迟显示加载态
// ============================================================

/**
 * 只有当 `active` 连续为真超过 `delay` 毫秒后才返回 true。
 *
 * 用途：首屏 / 切换库时用骨架屏，但请求 <300ms 就回来的场景不该先闪一下骨架
 * （R-D-15「≥300ms 才显示」）。SSR / 单测（无 setTimeout 副作用要求）返回 false。
 */
export function useDelayedFlag(active: boolean, delay: number = LOADING_DELAY_MS): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);
  return show;
}

// ============================================================
// R-I-03 · 搜索防抖 300ms
// ============================================================

/**
 * 输入防抖：本地值立刻回显（输入不卡），远端提交延迟 `delay` 毫秒。
 * 卸载时若仍有未提交值，默认丢弃（由调用方决定是否 flush）。
 */
export function useDebouncedCommit(
  initial: string,
  onCommit: (v: string) => void,
  delay: number = SEARCH_DEBOUNCE_MS,
): { value: string; setValue: (v: string) => void; pending: boolean } {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const cbRef = useRef(onCommit);
  cbRef.current = onCommit;
  // 已提交（或无需提交）的权威值。挂载 / 外部回灌时 value 恒等于它，提交 effect 直接跳过。
  // 注意：不能用「首次 effect 跳过」标志：React 18 StrictMode 开发态会 mount → cleanup → 再 mount，
  //   同一组件实例内该标志已被置位，第二次 effect 不再跳过，于是挂载约 300ms 后把初始值当成
  //   用户输入自动提交一次（2026-10-06 E2E 抓到的「零点击自动 PATCH 整份 config、把排序写乱」）。
  //   改成比较值，跑任意次都是幂等的。
  const committedRef = useRef(initial);

  // 外部值（如切换视图重置）回灌：连同权威值一起重置，避免把旧视图的待提交值带进新视图。
  useEffect(() => {
    committedRef.current = initial;
    setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => {
    if (value === committedRef.current) return; // 挂载 / 回灌：无变化，绝不自动提交
    setPending(true);
    const t = setTimeout(() => {
      committedRef.current = value;
      setPending(false);
      cbRef.current(value);
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay]);

  return { value, setValue, pending };
}

// ============================================================
// R-I-03 / R-I-04 · 工具栏搜索框 + 「筛选中」徽标
// ============================================================

/**
 * 列表搜索框（R-I-03）：宽 170 × 高 32，底 gx-control，图标 14，占位 12 hint 色。
 * `searching` 为真时按「搜索期间保留旧结果并置灰」处理（只降透明度，不卸载内容）。
 *
 * `width={null}` 表示不定宽（交给 className 控制）：窄屏（<768）工具栏要让它随主轴伸缩，
 * 内联 width:170px 会把它顶出容器。默认仍是规范的 170（R-I-03 / 附录 B）。
 */
export function ListSearchBox({
  value,
  onChange,
  placeholder = "搜索…",
  searching,
  width = SEARCH_BOX_W,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  searching?: boolean;
  width?: number | null;
  className?: string;
}) {
  return (
    <div
      className={clsx("relative shrink-0", width == null && "w-full", className)}
      style={width == null ? undefined : { width }}
    >
      <Icon
        name="search"
        size={14}
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gx-text-hint"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={clsx(
          "h-8 w-full rounded-gx-lg border border-gx-border bg-gx-control pl-7 pr-2 text-gx-12",
          "text-gx-text-primary placeholder:text-gx-text-hint",
          "transition-colors duration-[120ms] focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent/50",
          FOCUS_RING,
        )}
      />
    </div>
  );
}

/** R-I-04 工具栏「筛选中」徽标：圆角 4（徽标档）+ 11px，与 R-N-17 同规格但用 accent 色表示"生效中"。 */
export function FilterActiveBadge({ count, onClear }: { count?: number; onClear?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title={onClear ? "清除全部筛选条件" : "当前有筛选条件生效"}
      data-gx-filtering="true"
      className={clsx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-gx-sm bg-gx-accent-bg px-1.5 text-gx-11 text-gx-accent",
        onClear ? "transition-colors duration-[120ms] hover:bg-gx-row-hover" : "cursor-default",
        FOCUS_RING,
      )}
    >
      <Icon name="filter" size={11} />
      筛选中
      {count != null && count > 0 && <span className="font-medium">{count}</span>}
    </button>
  );
}

// ============================================================
// R-I-29 · 长文本截断 + title 全文
// ============================================================

/**
 * 长文本统一截断：单行省略 + `title` 全文（R-I-29 禁止「overflow:hidden 无提示截断」）。
 * 多行场景传 `lines`（1 或 2），靠 CSS line-clamp 实现；title 始终带全文。
 */
export function TruncatedText({
  text,
  lines = 1,
  className,
  title,
}: {
  text: string;
  lines?: 1 | 2;
  className?: string;
  /** 覆盖 title（默认就是 text 全文） */
  title?: string;
}) {
  const full = title ?? text;
  return (
    <span
      title={full}
      data-gx-truncated="true"
      className={clsx(
        "min-w-0",
        lines === 1 ? "block truncate" : "block overflow-hidden",
        className,
      )}
      style={lines === 2 ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } : undefined}
    >
      {text}
    </span>
  );
}

// ============================================================
// R-I-21 · 状态胶囊
// ============================================================

/**
 * 状态类字段胶囊（R-I-21）：圆角 9999 + 11px + 语义色底 + 深一档字。
 * 与既有 `Badge`（12px，用于通用标签）区分：状态列按规范走 11px。
 * 颜色来源仍是选项自带 color（用户可配），不新增任何硬编码色值。
 */
/** 把单色 hex 解析为 rgb 三元组；非 hex（如 rgb()/命名色）返回 null 由调用方降级。 */
export function parseHexColor(c: string): [number, number, number] | null {
  const m = c.trim().match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * 选项色统一混色口径（#693）：原色 18% 浅底 + 同系原色 50% 边框 +
 * darkenForText 同系深字。StatusPill / SelectPill / DetailLayout 选项 pill
 * 三处共用此函数，不允许复制第三套混色代码。
 * color 缺失/非 hex 返回 undefined，由调用方走 gx-* token 兜底。
 */
export function optionTone(color?: string | null): CSSProperties | undefined {
  const rgb = color ? parseHexColor(color) : null;
  if (!rgb) return undefined;
  return {
    backgroundColor: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.18)`,
    borderColor: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.5)`,
    color: darkenForText(rgb),
  };
}

export function StatusPill({
  label,
  color,
  className,
}: {
  label: string;
  color?: string;
  className?: string;
}) {
  // 语义色底 + 语义色深字（参考图四态：进行中蓝 / 待评审橙 / 已完成绿 / 待开始灰）：
  // 底色取原色 18%、边框取原色 50%，文字取原色**压暗一档**（与 Badge 同一取色函数
  // darkenForText），既保留"同色系"语义，又满足浅底上的 4.5:1 对比度。
  // 非 hex（rgb()/命名色）无法可靠压暗 → 整体降级走 gx-* token，不拼非法色值。
  const style = optionTone(color);
  return (
    <span
      data-gx-status-pill="true"
      title={label}
      className={clsx(
        "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-gx-11 font-medium leading-none",
        style ? "" : "border-gx-border bg-gx-row-hover text-gx-text-secondary",
        className,
      )}
      style={style}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

// ============================================================
// R-I-22 · 横向步骤条
// ============================================================

export interface StepDef {
  id: string;
  label: string;
  /** 可选的副说明（11px hint） */
  hint?: string;
}

/**
 * 横向步骤条（R-I-22）：当前态高亮 `gx-accent`，已完成打勾，未开始 `gx-text-hint`。
 *
 * 现网无审批流转功能（R-I-23~25 无调用点），本组件服务真实存在的多步流程：
 * 导入四步（R-I-17）。语义与规范一致：当前 = accent，已完成 = 打勾，未开始 = hint 灰。
 */
export function StepBar({
  steps,
  current,
  className,
}: {
  steps: StepDef[];
  /** 当前步下标（0 基）；小于该下标的算已完成 */
  current: number;
  className?: string;
}) {
  return (
    <ol
      data-gx-stepbar="true"
      aria-label="流程步骤"
      className={clsx("flex items-center gap-2", className)}
    >
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={clsx(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gx-11 font-medium",
                done && "bg-gx-accent-bg text-gx-accent",
                active && "bg-gx-accent text-white",
                !done && !active && "bg-gx-row-hover text-gx-text-hint",
              )}
            >
              {done ? <Icon name="check" size={12} /> : i + 1}
            </span>
            <span className="min-w-0">
              <span
                className={clsx(
                  "block truncate text-gx-12",
                  active ? "font-medium text-gx-accent" : done ? "text-gx-text-secondary" : "text-gx-text-hint",
                )}
                title={s.label}
              >
                {s.label}
              </span>
              {s.hint && <span className="block truncate text-gx-11 text-gx-text-hint">{s.hint}</span>}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={clsx("h-px min-w-4 flex-1", done ? "bg-gx-accent" : "bg-gx-hairline")}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ============================================================
// R-I-13 · 三态复选框
// ============================================================

/**
 * 表头三态复选框（R-I-13）：未选 / 部分选（横线）/ 全选。
 * 用 `indeterminate` 原生属性表达"部分选"，视觉上渲染一条横线。
 */
export function TriStateCheckbox({
  state,
  onChange,
  label = "选择本页全部",
  disabled,
}: {
  state: "none" | "partial" | "all";
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "partial";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      title={label}
      disabled={disabled}
      checked={state === "all"}
      onChange={(e) => onChange(e.target.checked)}
      className={clsx(
        "h-4 w-4 accent-gx-accent",
        // 部分选：原生 indeterminate 在各浏览器表现不一致，用横线兜底（保持可点击）
        state === "partial" && "gx-tristate-partial",
      )}
    />
  );
}

// ============================================================
// R-I-12 / R-I-14 · 批量操作条
// ============================================================

/**
 * 批量操作条（R-I-12）：勾选后**替换**原工具栏，显示「已选 N 条」+ 操作 + 取消选择。
 *
 * R-I-13：「全选」只作用于当前页，故额外提供「选择全部 N 条」文字链接（总数 > 已选时显示）。
 * R-I-14：危险操作按钮上直接带影响条数（「删除 3 条记录」），不用「删除」这种无信息量文案。
 */
export function BulkActionBar({
  count,
  total,
  actions,
  onSelectAll,
  onClearSelection,
  className,
}: {
  count: number;
  /** 当前筛选后的总条数；大于 count 时才显示「选择全部 N 条」 */
  total?: number;
  actions: ReactNode;
  onSelectAll?: () => void;
  onClearSelection: () => void;
  className?: string;
}) {
  const canSelectAll = !!onSelectAll && total != null && total > count;
  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      data-gx-bulk-bar="true"
      className={clsx(
        "flex h-12 shrink-0 items-center gap-2 border-b border-gx-separator bg-gx-accent-bg px-3",
        className,
      )}
    >
      <span className="shrink-0 text-gx-13 font-medium text-gx-accent">已选 {count} 条</span>
      {canSelectAll && (
        <button
          type="button"
          onClick={onSelectAll}
          className={clsx(
            "shrink-0 rounded-gx-lg px-1.5 py-0.5 text-gx-12 text-gx-accent underline decoration-gx-accent/40 underline-offset-2",
            "transition-colors duration-[120ms] hover:bg-gx-row-hover",
            FOCUS_RING,
          )}
        >
          选择全部 {total} 条
        </button>
      )}
      <span aria-hidden className="h-5 w-px shrink-0 bg-gx-border" />
      <div className="flex min-w-0 flex-1 items-center gap-2">{actions}</div>
      <Button size="sm" variant="ghost" onClick={onClearSelection} className="shrink-0">
        取消选择
      </Button>
    </div>
  );
}

// ============================================================
// R-I-26 · 防重复提交（写操作在途守卫）
// ============================================================

export interface WriteGuard {
  /** 是否有任意在途写操作 */
  busy: boolean;
  /** 指定 key 是否在途（用于按按钮粒度禁用） */
  isBusy: (key?: string) => boolean;
  /**
   * 执行写操作。同 key 已有在途请求时**直接返回 undefined**（吞掉重复提交），
   * 不并发、不排队——R-I-27 明确「不自动重试写操作」，排队重试同样会产生两条记录。
   */
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined>;
}

/**
 * R-I-26：所有写操作按钮点击后立即禁用并显示 spinner，防止双击重复提交。
 *
 * 与「按钮 loading 态」互补：loading 只挡住一个按钮，这里按 key 去重，
 * 能挡住「同一个动作有多个入口 / 快速连点 / 双击」三类重复提交。
 */
export function useWriteGuard(): WriteGuard {
  const inflight = useRef<Set<string>>(new Set());
  const [, setVersion] = useState(0);
  // ref 变动不会触发重渲染，用一个自增版本号强制刷新，让按钮的 disabled / loading 生效
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const isBusy = (key?: string): boolean =>
    key == null ? inflight.current.size > 0 : inflight.current.has(key);

  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (inflight.current.has(key)) return undefined;
    inflight.current.add(key);
    bump();
    try {
      return await fn();
    } finally {
      inflight.current.delete(key);
      bump();
    }
  }, [bump]);

  return { busy: isBusy(), isBusy, run };
}

// ============================================================
// R-I-02 / R-D-27 · 分页口径与局部刷新遮罩
// ============================================================

/**
 * R-I-02：是否应切换为分页器（记录数 > 5000 或用户手动切过页码）。
 * 默认口径是无限滚动 + 底部「已加载 N 条」。
 */
export function shouldUsePaginator(total: number, userPaged: boolean): boolean {
  return userPaged || total > PAGINATE_THRESHOLD;
}

/** 已加载条数文案（R-I-02「底部『已加载 N 条』」） */
export function loadedCountText(loaded: number, total?: number): string {
  return total != null && total !== loaded ? `已加载 ${loaded} / ${total} 条` : `已加载 ${loaded} 条`;
}

/**
 * R-D-27：局部刷新（翻页 / 筛选）不用骨架屏，保留旧内容 + 内容区 `opacity .6`。
 * 只负责给出容器 class，调用方决定是否叠加 2px 顶部进度条。
 */
export function refreshingClass(refreshing: boolean): string {
  return refreshing ? "opacity-60 transition-opacity duration-[120ms]" : "";
}

// ============================================================
// R-I-09 · 行操作菜单顺序（复制 → 重命名/编辑 → … → 分隔线 → 删除）
// ============================================================

/**
 * R-I-09：行操作菜单顺序固定，删除永远在最后且为红色。
 * 这里只做**排序归并**——调用方依旧自己拼菜单项，本函数保证"删除类永远排最后"。
 */
export function orderRowMenu<T extends { danger?: boolean }>(items: T[]): T[] {
  const danger = items.filter((i) => i.danger);
  const rest = items.filter((i) => !i.danger);
  return [...rest, ...danger];
}

// ============================================================
// 危险操作分级提示（R-D-23）的文案助手
// ============================================================

/** R-D-24：确认弹窗主按钮必须是具体动词 + 对象，禁止「确定 / OK」。 */
export function bulkDeleteText(count: number, noun = "条记录"): string {
  return `删除 ${count} ${noun}`;
}

// ============================================================
// R-I-08 / R-D-22 · 软删除的统一撤销反馈
// ============================================================

/**
 * 软删除（进回收站）成功后的统一 toast（R-D-22：删除/归档类成功 toast 必须带「撤销」，6s）。
 *
 * 撤销失败必须显式报 error toast——撤销静默失败等于骗用户「东西还在」。
 * 阶段 3 已在 RecordDrawer / GridView 批量删除 / KbTree 三处手写同款逻辑，
 * 阶段 4 收敛成这一个入口，剩余删除点直接复用。
 */
export function toastDeleted(opts: {
  /** 结果文案，带对象名：「已删除「需求池」」 */
  message: string;
  /** 撤销动作（恢复接口） */
  onUndo: () => Promise<unknown>;
  /** 恢复成功文案，缺省「已恢复」 */
  restoredMessage?: string;
}): number {
  return toast(opts.message, {
    kind: "success",
    action: {
      label: "撤销",
      onClick: () => {
        void Promise.resolve()
          .then(() => opts.onUndo())
          .then(() => toast(opts.restoredMessage ?? "已恢复", "success"))
          .catch((e: unknown) => toast((e as Error)?.message ?? "撤销失败，请到回收站手动恢复", "error"));
      },
    },
  });
}

/** 导出图标名收敛（工具栏 / 批量条共用，避免各写一份） */
export const BULK_ICONS = {
  edit: "edit",
  delete: "trash",
  export: "download",
} satisfies Record<string, IconName>;

// apps/web/src/components/EntityIconPicker.tsx
// 五类实体（智能数据库 / 知识库 / 数据表 / 文档 / 画布）自定义「图标 + 颜色」的统一受控入口。
//
// 边界（按 implementation 契约，勿擅自放宽）：
//   - 图标白名单读 @gx/shared-types 的 ENTITY_ICONS（唯一真源，本文件不重抄一份）；
//   - 色板复用 ui.tsx 的 COLOR_PALETTE（12 色既有资产，不新造色板）；
//   - 未自定义 = icon 为 null：resolveEntityIcon 原样返回调用方给的 fallback，
//     因此所有展示位「改动前后逐像素一致」；自定义后才走到 {icon, iconColor} 分支；
//   - 选图标 / 选色即时 onChange 持久化（无「确定」按钮），失败由本组件统一 toast。
// 视觉：圆角 8（rounded-gx-lg）、浮层 shadow-gx-lg + gx-z-popover、150ms ease-out，
//       颜色一律 gx-* 令牌（用户自定义色属于数据，不是硬编码）。

import { useRef, useState, type ReactNode } from "react";
import { ENTITY_ICONS, isEntityIcon, isEntityIconColor } from "@gx/shared-types";
import { Icon, type IconName } from "./icons";
import { COLOR_PALETTE, Popover, toast } from "./ui";

/** 任一实体的图标字段形态（DTO 已统一为 icon/iconColor 两键）。 */
export interface EntityIconValue {
  icon?: string | null;
  iconColor?: string | null;
}

/** 解析结果：图标名 + 可选颜色（无颜色时由渲染处继承父级前景色）。 */
export interface ResolvedEntityIcon {
  name: IconName;
  color?: string;
}

/**
 * 展示位取值唯一入口：未自定义（icon 为 null / 空 / 不在白名单）时【原样返回 fallback】，
 * 保证既有默认渲染零变化；自定义后返回实体图标名，颜色缺省回退到 fallback.color。
 *
 * 纯函数，无 IO、无 React 依赖，便于单测锁定。
 */
export function resolveEntityIcon(
  entity: EntityIconValue | null | undefined,
  fallback: { name: IconName; color?: string },
): ResolvedEntityIcon {
  const raw = entity?.icon;
  if (!raw || !isEntityIcon(raw)) return { name: fallback.name, color: fallback.color };
  const color = entity?.iconColor;
  return {
    name: raw,
    color: isEntityIconColor(color) ? (color as string) : fallback.color,
  };
}

/**
 * 展示位着色：实体自定义色（#RRGGBB）有效即用；未自定义返回 undefined
 * → 调用点不传 style，图标沿用容器前景色，与改动前完全一致。
 */
export function entityIconColor(entity: EntityIconValue | null | undefined): string | undefined {
  return isEntityIconColor(entity?.iconColor) ? (entity?.iconColor as string) : undefined;
}

/**
 * 展示位着色【保守规则】：只有实体自定义了【图标】时才连带套用自定义色。
 *
 * 为什么多数展示位用这条而不是 entityIconColor：
 *   - 「未自定义」的权威口径是 icon IS NULL（shared-types/nav.ts §实体白名单注释）；
 *     而 bases / knowledge_bases 的 iconColor 列非空、建库时就有值，它属于历史底色。
 *   - 若只要 iconColor 存在就着色，等于把所有从未改过图标的库也改成有色图标，
 *     违反「未自定义时渲染不变」的红线。故：图标换了才连带换色。
 *   - 唯一例外是库切换器下拉（它自己的头部圆点本来就一直显示 iconColor，
 *     下拉里丢色是同一组件内的不一致，属于本次要修的缺陷），那里用 entityIconColor。
 */
export function resolvedEntityColor(entity: EntityIconValue | null | undefined): string | undefined {
  return isEntityIconDefault(entity) ? undefined : entityIconColor(entity);
}

export type EntityIconIndex = Map<string, EntityIconValue>;

/**
 * 按实体资源 id 建图标索引（供 L1/L2 导航行按 node.resourceId 查实体自定义值）。
 * 只取 icon/iconColor 两键，不持有整个实体对象，避免列表失效时拿到过期快照。
 */
export function buildEntityIconIndex(
  bases: readonly (EntityIconValue & { id: string })[] | null | undefined,
  kbs: readonly (EntityIconValue & { id: string })[] | null | undefined,
): EntityIconIndex {
  const map: EntityIconIndex = new Map();
  // 入口校验：非白名单值一律按「未自定义」存 null，避免下游 <Icon name> 取不到 path 崩渲染
  const put = (e: EntityIconValue & { id: string }) =>
    map.set(e.id, {
      icon: isEntityIcon(e.icon) ? e.icon : null,
      iconColor: isEntityIconColor(e.iconColor) ? e.iconColor : null,
    });
  for (const b of bases ?? []) put(b);
  for (const k of kbs ?? []) put(k);
  return map;
}
export function isEntityIconDefault(entity: EntityIconValue | null | undefined): boolean {
  return !entity?.icon || !isEntityIcon(entity.icon);
}

/**
 * 实体图标渲染件：内部走 resolveEntityIcon，未自定义时输出与改动前完全一致的
 * `<Icon name={fallback.name} />`（含 fallback.color 的 style）。
 */
export function EntityIcon({
  entity,
  fallback,
  size = 16,
  className,
}: {
  entity?: EntityIconValue | null;
  fallback: { name: IconName; color?: string };
  size?: number;
  className?: string;
}) {
  const r = resolveEntityIcon(entity, fallback);
  return (
    <Icon
      name={r.name}
      size={size}
      className={className}
      style={r.color ? { color: r.color } : undefined}
    />
  );
}

/** 30 个白名单图标的中文可读名（纯图标按钮的可访问名称，读屏要念得出选的是什么）。 */
const ICON_LABEL: Record<string, string> = {
  database: "数据库",
  book: "知识库",
  table: "数据表",
  doc: "文档",
  canvas: "画布",
  grid: "网格",
  group: "分组",
  folder: "文件夹",
  folderOpen: "打开的文件夹",
  file: "文件",
  layers: "图层",
  image: "图片",
  star: "星标",
  home: "首页",
  checkSquare: "勾选",
  users: "成员",
  user: "个人",
  building: "组织",
  shield: "安全",
  sitemap: "导航层级",
  keyRound: "密钥",
  link: "链接",
  sparkles: "精选",
  clock: "时间",
  calendar: "日历",
  tags: "标签",
  hash: "编号",
  globe: "全局",
  bell: "提醒",
  eye: "可见",
};

/** 面板两处网格都是 6 列 × 32 格 + 6px 缝，宽度由此推出并作为默认面板宽。 */
const GRID_COLS = 6;
const CELL = 32;
const GAP = 6;
export const ENTITY_ICON_PANEL_W = GRID_COLS * CELL + (GRID_COLS - 1) * GAP + 24;

export interface EntityIconPickerProps {
  /** 当前自定义图标名；null = 未自定义（渲染 defaultIcon）。 */
  icon: string | null;
  /** 当前自定义色 #RRGGBB；null = 用各展示位的默认色。 */
  iconColor: string | null;
  /** 未自定义时的默认图标（实体本征：database / book / table / doc / canvas）。 */
  defaultIcon: IconName;
  /** 未自定义时的默认色；仅用于面板预览（展示位默认色各自保留）。 */
  defaultColor?: string;
  /** 选图标 / 选色即时调用；抛错由本组件 toast（沿用 toast 现有签名）。 */
  onChange: (next: { icon: string | null; iconColor: string | null }) => void | Promise<unknown>;
  /** 自定义触发器内容（children 插槽）；不传则渲染默认预览按钮。 */
  children?: ReactNode;
  /** 无写权限：只渲染预览，不挂面板（入口整体不渲染的责任在调用方）。 */
  readOnly?: boolean;
  ariaLabel?: string;
  /** 浮层宽度；缺省按 6 列网格推算（≈246）。 */
  panelWidth?: number;
  /** 触发器尺寸：32（默认，设置页/弹窗内）/ 20（行内紧凑入口）。 */
  triggerSize?: 32 | 20;
}

/**
 * 受控的「图标 + 颜色」选择器。
 *
 * 结构：触发器（children 插槽或默认预览按钮）→ Popover 面板：
 *   ① 选择图标：ENTITY_ICONS 30 个，6 列 × 32×32，hover 行 hover 色，选中 accent 边 + accent 底
 *   ② 选择颜色：COLOR_PALETTE 12 色 + 「默认」清除自定义色
 *   ③ 恢复默认：icon 与 iconColor 一并置 null（= 未自定义，回到各展示位原生默认渲染）
 * 交互：点选即持久（无确定按钮），失败 toast；Esc / 点外部关闭走 ui.tsx Popover 既有能力。
 */
export function EntityIconPicker({
  icon,
  iconColor,
  defaultIcon,
  defaultColor,
  onChange,
  children,
  readOnly = false,
  ariaLabel = "图标与颜色",
  panelWidth = ENTITY_ICON_PANEL_W,
  triggerSize = 32,
}: EntityIconPickerProps) {
  const [open, setOpen] = useState(false);
  // 触发器锚点：fixed 模式按它的视口矩形定位（不传 anchorEl 会回退到弹层父元素，坐标不准）
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resolved = resolveEntityIcon({ icon, iconColor }, { name: defaultIcon, color: defaultColor });
  const isDefault = isEntityIconDefault({ icon });

  const preview = (
    <Icon
      name={resolved.name}
      size={triggerSize === 32 ? 18 : 14}
      style={resolved.color ? { color: resolved.color } : undefined}
    />
  );

  async function commit(next: { icon: string | null; iconColor: string | null }) {
    try {
      await onChange(next);
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存图标失败", "error");
    }
  }

  if (readOnly) {
    // 无写权限只展示当前生效图标（未自定义即 fallback），不挂触发器语义
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-gx-lg border border-gx-border bg-gx-surface text-gx-text-primary"
        style={{ width: triggerSize, height: triggerSize }}
        title={ariaLabel}
      >
        {children ?? preview}
      </span>
    );
  }

  return (
    <div className="relative inline-flex shrink-0 align-middle">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex items-center justify-center rounded-gx-lg border border-gx-border bg-gx-surface",
          "text-gx-text-primary transition-colors duration-150 ease-out hover:bg-gx-row-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gx-accent/50",
        ].join(" ")}
        style={{ width: triggerSize, height: triggerSize }}
        data-entity-icon-trigger={open ? "open" : "closed"}
      >
        {children ?? preview}
      </button>
      {/* fixed 模式：portal 到 body（ui.tsx Popover），逃出 Modal 的 overflow-hidden / transform 裁剪，
          并按触发按钮视口坐标定位 + 自动上下翻转 / 限高滚动；层级 gx-z-popover(900) > gx-z-modal(800)。 */}
      <Popover open={open} onClose={() => setOpen(false)} width={panelWidth} fixed anchorEl={triggerRef.current}>
        <EntityIconPanel
          icon={icon}
          iconColor={iconColor}
          defaultIcon={defaultIcon}
          defaultColor={defaultColor}
          isDefault={isDefault}
          current={resolved}
          onPickIcon={(name) => void commit({ icon: name, iconColor })}
          // 选「默认颜色」时不要把 icon 顺带写成 defaultIcon：Base/KB 的 iconColor 列 NOT NULL，
          // 后端把 null 映射回系统默认色后 icon 若被写成默认值，isEntityIconDefault 会翻假，
          // 图标反而被着色 —— 与「未自定义零变化」相悖。只有选了具体颜色才需要连带落图标名。
          onPickColor={(c) => void commit({ icon: c === null ? icon ?? null : icon ?? defaultIcon, iconColor: c })}
          onReset={() => void commit({ icon: null, iconColor: null })}
        />
      </Popover>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="px-1 py-1 text-gx-11 font-medium text-gx-text-hint">{children}</div>;
}

/** 面板本体（单独导出以便 SSR 断言「30 图标 / 12 色 / 恢复默认」）。 */
export function EntityIconPanel({
  icon,
  iconColor,
  defaultIcon,
  defaultColor,
  isDefault,
  current,
  onPickIcon,
  onPickColor,
  onReset,
}: {
  icon: string | null;
  iconColor: string | null;
  defaultIcon: IconName;
  defaultColor?: string;
  isDefault?: boolean;
  current?: ResolvedEntityIcon;
  onPickIcon: (name: string) => void;
  onPickColor: (color: string | null) => void;
  onReset: () => void;
}) {
  const preview = current ?? resolveEntityIcon({ icon, iconColor }, { name: defaultIcon, color: defaultColor });
  const isDef = isDefault ?? isEntityIconDefault({ icon });
  const colorValue = isEntityIconColor(iconColor) ? iconColor : null;
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2 pb-1">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-gx-lg bg-gx-bg"
          data-entity-icon-preview={preview.name}
        >
          <Icon name={preview.name} size={18} style={preview.color ? { color: preview.color } : undefined} />
        </span>
        <span className="text-gx-12 text-gx-text-secondary">
          {isDef ? "当前：默认图标" : "当前：自定义图标"}
        </span>
      </div>

      <SectionTitle>选择图标</SectionTitle>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
        role="radiogroup"
        aria-label="选择图标"
      >
        {ENTITY_ICONS.map((name) => {
          const selected = !isDef && icon === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={ICON_LABEL[name] ?? name}
              title={ICON_LABEL[name] ?? name}
              onClick={() => onPickIcon(name)}
              className={[
                "flex items-center justify-center rounded-gx-lg border",
                "text-gx-text-primary transition-colors duration-150 ease-out",
                selected
                  ? "border-gx-accent bg-gx-accent-bg text-gx-accent"
                  : "border-transparent hover:bg-gx-row-hover",
              ].join(" ")}
              style={{ width: CELL, height: CELL }}
              data-icon-name={name}
              data-selected={selected ? "true" : "false"}
            >
              <Icon name={name as IconName} size={16} />
            </button>
          );
        })}
      </div>

      <SectionTitle>选择颜色</SectionTitle>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
        role="radiogroup"
        aria-label="选择颜色"
      >
        {COLOR_PALETTE.map((c) => {
          const selected = colorValue === c;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`颜色 ${c}`}
              title={c}
              onClick={() => onPickColor(c)}
              className={[
                "flex items-center justify-center rounded-gx-lg border transition-colors duration-150 ease-out",
                selected ? "border-gx-accent bg-gx-accent-bg" : "border-transparent hover:bg-gx-row-hover",
              ].join(" ")}
              style={{ width: CELL, height: CELL }}
              data-color={c}
              data-selected={selected ? "true" : "false"}
            >
              <span className="h-5 w-5 rounded-full" style={{ backgroundColor: c }} />
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={colorValue === null}
          aria-label="默认颜色"
          title="默认颜色"
          onClick={() => onPickColor(null)}
          className={[
            "flex items-center justify-center rounded-gx-lg border transition-colors duration-150 ease-out",
            colorValue === null
              ? "border-gx-accent bg-gx-accent-bg"
              : "border-transparent hover:bg-gx-row-hover",
          ].join(" ")}
          style={{ width: CELL, height: CELL }}
          data-color="default"
          data-selected={colorValue === null ? "true" : "false"}
        >
          <span className="h-5 w-5 rounded-full border border-gx-border-strong bg-gx-surface">
            <span className="block h-full w-full rounded-full bg-gx-text-hint/40" />
          </span>
        </button>
      </div>

      <button
        type="button"
        disabled={isDef}
        onClick={onReset}
        title={isDef ? "当前已是默认图标与颜色" : "恢复默认图标与颜色"}
        className={[
          "mt-0.5 rounded-gx-lg px-2 py-1.5 text-gx-12 transition-colors duration-150 ease-out",
          isDef
            ? "cursor-not-allowed text-gx-text-hint"
            : "text-gx-text-secondary hover:bg-gx-row-hover hover:text-gx-text-primary",
        ].join(" ")}
        data-entity-icon-reset="true"
      >
        恢复默认
      </button>
    </div>
  );
}

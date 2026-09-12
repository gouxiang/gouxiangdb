// 单元格只读渲染（28 种字段类型全覆盖）
// 纯展示组件：按 field.type 分派渲染，计算/系统字段用弱化文本色提示不可编辑。

import { clsx } from "clsx";
import type { CellValue, FieldDTO, LinkRefDTO, RecordDTO, PermissionSet } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Badge } from "../../components/ui";
import { MdContent } from "../../components/MdContent";
import { sanitizeHtml } from "../../lib/sanitize-html";
import { formatCell, isEmptyValue, resolveSelectOption, COMPUTED_TYPES } from "./format";

export interface CellRendererProps {
  value: CellValue;
  field: FieldDTO;
  record?: RecordDTO;
  permissions?: PermissionSet;
  onOpenRecord?: (linkRef: LinkRefDTO) => void;
}

/** 数字类字段用等宽数字右对齐 */
function numericClass(field: FieldDTO): string {
  if (["number", "currency", "percent", "count", "rollup", "autoNumber"].includes(field.type)) {
    return "justify-end text-right tabular-nums";
  }
  return "justify-start text-left";
}

export function CellRenderer({ value, field, record, permissions, onOpenRecord }: CellRendererProps) {
  // tabs 是字段分组容器：不渲染 cell（统一在 detail view 由 TabsPanel 处理）
  if (field.type === "tabs") return null;
  // 计算字段 / 系统字段：弱化文本色
  const tertiary = COMPUTED_TYPES.has(field.type);
  const empty = isEmptyValue(value);

  const wrap = (children: React.ReactNode, extra = "") =>
    (
      <div
        className={clsx(
          "flex h-full w-full items-center gap-1 px-2.5 py-1 text-gx-13",
          numericClass(field),
          tertiary ? "text-gx-text-tertiary" : "text-gx-text-primary",
          extra,
        )}
      >
        {children}
      </div>
    );

  switch (field.type) {
    // ---------- 选择类：彩色胶囊 ----------
    case "singleSelect": {
      if (empty) return wrap(null);
      const opt = resolveSelectOption(field, value);
      return wrap(
        opt ? (
          <Badge color={opt.color}>{opt.name}</Badge>
        ) : (
          <span>{String(value)}</span>
        ),
      );
    }

    case "multiSelect": {
      if (empty) return wrap(null);
      const arr = Array.isArray(value) ? (value as CellValue[]) : [value];
      return wrap(
        <span className="flex flex-wrap gap-1">
          {arr.map((v, i) => {
            const opt = resolveSelectOption(field, v);
            return (
              <Badge key={i} color={opt?.color}>
                {opt ? opt.name : String(v)}
              </Badge>
            );
          })}
        </span>,
      );
    }

    // ---------- 复选框 ----------
    case "checkbox":
      return wrap(
        <span
          className={clsx(
            "inline-flex h-4 w-4 items-center justify-center rounded border",
            value ? "border-gx-accent bg-gx-accent text-white" : "border-gx-border",
          )}
        >
          {value ? <Icon name="check" size={12} /> : null}
        </span>,
      );

    // ---------- 评分 ----------
    case "rating": {
      const n = typeof value === "number" ? value : Number(value) || 0;
      return wrap(
        <span className="inline-flex gap-0.5">
          {[1, 2, 3, 4, 5].map((i) => (
            <Icon
              key={i}
              name="star"
              size={14}
              className={i <= n ? "text-gx-warning" : "text-gx-text-hint"}
              fill={i <= n ? "currentColor" : "none"}
            />
          ))}
        </span>,
      );
    }

    // ---------- 关联：可点击胶囊 ----------
    case "links": {
      if (empty) return wrap(null);
      const links = Array.isArray(value) ? (value as LinkRefDTO[]) : [];
      return wrap(
        <span className="flex flex-wrap gap-1">
          {links.map((l) => (
            <button
              key={l.recordId}
              type="button"
              className="rounded-full bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-primary hover:bg-gx-accent-bg"
              onClick={(e) => {
                e.stopPropagation();
                onOpenRecord?.(l);
              }}
            >
              {l.title}
            </button>
          ))}
        </span>,
      );
    }

    // ---------- 附件 ----------
    case "attachment": {
      if (empty) return wrap(null);
      const files = Array.isArray(value) ? (value as { name?: string }[]) : [];
      return wrap(
        <span className="flex items-center gap-1 truncate">
          <Icon name="paperclip" size={12} className="shrink-0 text-gx-text-hint" />
          <span className="truncate">
            {files.map((f) => f.name ?? "").filter(Boolean).join("、 ")}
          </span>
        </span>,
      );
    }

    // ---------- 富文本 ----------
    case "richText": {
      const raw = typeof value === "string" ? value : "";
      if (!raw) return wrap(null);
      // 消毒后再渲染：richText 存的是用户可写 HTML，未消毒会造成存储型 XSS（<img onerror> 等）
      const html = sanitizeHtml(raw);
      return (
        <div
          className={clsx(
            "h-full w-full overflow-hidden px-2.5 py-1 text-gx-13 text-gx-text-primary",
            "whitespace-pre-wrap break-words",
          )}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }

    // ---------- 长文本：Markdown 行内格式渲染（粗/斜/删/码/高亮/链接），单行截断 ----------
    case "longText":
      if (empty) return wrap(null);
      return wrap(
        <MdContent
          md={String(value)}
          variant="inline"
          className="w-full truncate md-cell-inline"
        />,
      );

    // ---------- 邮箱 / 网址 / 电话：可点击链接 ----------
    case "email":
      if (empty) return wrap(null);
      return wrap(
        <a href={`mailto:${String(value)}`} className="text-gx-accent hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>,
      );

    case "url":
      if (empty) return wrap(null);
      return wrap(
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          className="truncate text-gx-accent hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value)}
        </a>,
      );

    case "phone":
      if (empty) return wrap(null);
      return wrap(
        <a href={`tel:${String(value)}`} className="text-gx-accent hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>,
      );

    // ---------- 日期类：主文本色 ----------
    case "date":
    case "datetime":
    case "createdTime":
    case "lastModifiedTime":
      if (empty) return wrap(null);
      return wrap(<span className="truncate">{formatCell(value, field)}</span>);

    // ---------- 其余（含计算字段）----------
    default:
      if (empty) return wrap(null);
      return wrap(<span className="truncate">{formatCell(value, field)}</span>);
  }
}

export default CellRenderer;

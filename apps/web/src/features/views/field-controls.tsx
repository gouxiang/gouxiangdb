// apps/web/src/features/views/field-controls.tsx
// 非网格视图共用的「字段值展示」与「内联编辑控件」
// 统一处理 28 种字段类型的取值/渲染，避免各视图重复实现
// 约定：所有颜色走 token（gx-*），不硬编码；计算/系统字段只读弱化

import { clsx } from "clsx";
import { useState } from "react";
import type {
  CellValue,
  FieldDTO,
  LinkRefDTO,
  PermissionSet,
  SelectOption,
  ViewDTO,
} from "@gx/shared-types";
import { FieldIcon } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AttachmentLinks } from "../cells/AttachmentLinks";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { openFilePreview } from "../attachments/preview-opener";
import { attachmentFromLink } from "../attachments/policy";
import { MemberDisplay, MemberSelect, useMemberRoster } from "../contacts/member-roster";

/** 所有非网格视图统一的 props（由 ViewRouter 注入） */
export interface ViewProps {
  baseId: string;
  tableId: string;
  viewId: string;
  view: ViewDTO;
  permissions: PermissionSet;
  onOpenRecord?: (ref: { tableId: string; recordId: string; title: string }) => void;
}

// ============ 工具函数 ============

/** singleSelect 的值可能是 option.id 也可能是 option.name，这里统一解析成选项对象 */
export function resolveSelectOption(field: FieldDTO, value: CellValue): SelectOption | undefined {
  if (!field.options || value == null || value === "") return undefined;
  const v = String(value);
  return field.options.find((o) => o.id === v || o.name === v);
}

/** 把存储的 ISO 字符串格式化为可读文本（withTime 决定是否带时分） */
export function formatDateValue(value: CellValue, withTime: boolean): string {
  if (value == null || value === "") return "";
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!withTime) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 数字按字段精度格式化（currency/percent 仅做千分位+精度，单位由调用方加） */
export function formatNumber(value: CellValue, precision: number | null): string {
  const n = Number(value);
  if (isNaN(n)) return "0";
  // 与 cells/format.ts 的 fmtPrecision 同口径：precision 未配置（null/undefined）时
  // **不补位也不截位**，按数字自然形式展示。兜底成 0 会把 -3.5 显示成 -4，
  // 而后端实存的就是 -3.5，用户会以为自己存的数被改了。
  if (precision == null || !Number.isFinite(precision)) {
    return n.toLocaleString("zh-CN", { maximumFractionDigits: 20 });
  }
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** 计算字段（formula/rollup/count/lookup）或系统字段只读 */
export function isReadonlyField(field: FieldDTO): boolean {
  return (
    field.type === "formula" ||
    field.type === "rollup" ||
    field.type === "count" ||
    field.type === "lookup" ||
    field.type === "autoNumber" || // 自动编号系统生成，不可手输
    field.type === "tabs" ||  // 选项卡容器无 cell value
    field.type === "subtable" || // 子表格自身值由 UI 操作
    field.type === "createdTime" ||
    field.type === "lastModifiedTime" ||
    field.type === "createdBy" ||
    field.type === "lastModifiedBy"
  );
}

// ============ 展示控件 ============

/** 单选/多选的彩色胶囊 */
export function SelectPill({ option, multi }: { option: SelectOption; multi?: boolean }) {
  return (
    <span
      className={clsx(
        "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-gx-12 font-medium",
        multi && "border border-gx-border",
      )}
      style={{ backgroundColor: option.color, color: "#FFFFFF" }}
    >
      {option.name}
    </span>
  );
}

/**
 * 字段值展示组件。
 * onLink 用于 links 类型点击跳转（打开关联记录抽屉）。
 */
export function FieldValue({
  field,
  value,
  onLink,
  emptyText = "—",
}: {
  field: FieldDTO;
  value: CellValue;
  onLink?: (ref: LinkRefDTO) => void;
  emptyText?: string;
}) {
  // 空值
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-gx-13 text-gx-text-hint">{emptyText}</span>;
  }

  switch (field.type) {
    case "member":
      return <FieldMemberDisplay value={value} />;

    case "singleSelect": {
      const opt = resolveSelectOption(field, value);
      if (!opt) return <span className="text-gx-13 text-gx-text-primary">{String(value)}</span>;
      return <SelectPill option={opt} />;
    }
    case "multiSelect": {
      const arr = Array.isArray(value) ? value : [value];
      const opts = arr
        .map((v) => resolveSelectOption(field, v as CellValue))
        .filter((o): o is SelectOption => !!o);
      if (opts.length === 0) return <span className="text-gx-13 text-gx-text-hint">{emptyText}</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {opts.map((o, i) => (
            <SelectPill key={o.id ?? i} option={o} multi />
          ))}
        </div>
      );
    }
    case "checkbox":
      return (
        <span className={`inline-flex items-center gap-1 ${value ? "text-gx-success" : "text-gx-text-hint"}`}>
          {value ? <Icon name="check" size={14} /> : <Icon name="close" size={14} />}
          <span>{value ? "是" : "否"}</span>
        </span>
      );
    case "rating": {
      const n = Number(value) || 0;
      return (
        <span className="inline-flex items-center gap-0.5 text-gx-13 text-gx-warning">
          {Array.from({ length: 5 }).map((_, i) => (
            <Icon key={i} name="star" size={14} className={i < n ? "opacity-100" : "opacity-25"} />
          ))}
          <span className="ml-1 text-gx-text-tertiary">{n}/5</span>
        </span>
      );
    }
    case "number":
    case "currency":
    case "percent":
    case "duration": {
      const txt = formatNumber(value, field.precision);
      const suffix = field.type === "currency" ? " ¥" : field.type === "percent" ? "%" : "";
      return (
        <span className="text-gx-13 text-gx-text-primary" style={{ fontVariantNumeric: "tabular-nums" }}>
          {txt}
          {suffix}
        </span>
      );
    }
    case "date":
      return <span className="text-gx-13 text-gx-text-primary">{formatDateValue(value, false)}</span>;
    case "datetime":
      return <span className="text-gx-13 text-gx-text-primary">{formatDateValue(value, true)}</span>;
    case "attachment": {
      const files = Array.isArray(value) ? (value as Array<{ url: string; name: string }>) : [];
      if (files.length === 0) return <span className="text-gx-13 text-gx-text-hint">{emptyText}</span>;
      // 单一真源 AttachmentLinks：与网格/详情同一份实现（同款视觉 + 同款下载属性）。
      // 相比原实现新增 download——附件是 dataURL，没有 download 时现代浏览器会因
      // 「禁止顶层导航到 data: URL」而点不开。
      // 卡片里点文件名进在线预览，另给一枚显式下载按钮（下载入口不被预览吞掉）。
      return (
        <AttachmentLinks value={value} onPreview={(f) => openFilePreview(attachmentFromLink(f))} />
      );
    }
    case "links": {
      const refs = Array.isArray(value) ? (value as LinkRefDTO[]) : [];
      if (refs.length === 0) return <span className="text-gx-13 text-gx-text-hint">{emptyText}</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {refs.map((r, i) => (
            <button
              key={r.recordId ?? i}
              type="button"
              onClick={() => onLink?.(r)}
              className="inline-flex items-center gap-1 rounded-full bg-gx-accent-bg px-2 py-0.5 text-gx-12 font-medium text-gx-accent hover:brightness-95"
            >
              <FieldIcon type="link" size={11} />
              {r.title || "未命名"}
            </button>
          ))}
        </div>
      );
    }
    case "longText":
    case "richText":
      return (
        <span className="block whitespace-pre-wrap break-words text-gx-13 text-gx-text-primary">
          {String(value)}
        </span>
      );
    default:
      // 计算字段 / 文本类统一展示
      return <span className="text-gx-13 text-gx-text-primary break-words">{String(value)}</span>;
  }
}

// ============ 编辑控件 ============

/**
 * 内联编辑控件（用于抽屉/表单）。
 * 计算字段与系统字段只读，其余类型可编辑。
 * 受控组件：value + onChange（onBlur 由调用方决定是否提交）。
 */
/** 附件上传的库上下文（选填：缺省时由上传组件从路由推导）。 */
export interface AttachmentContext {
  baseId?: string | null;
  tableId?: string | null;
  recordId?: string | null;
}

export function FieldInput({
  field,
  value,
  onChange,
  disabled,
  autoFocus,
  onBlur,
  attachmentContext,
}: {
  field: FieldDTO;
  value: CellValue;
  onChange: (v: CellValue) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  onBlur?: () => void;
  attachmentContext?: AttachmentContext;
}) {
  if (isReadonlyField(field)) {
    return (
      <div className="rounded-gx-sm bg-gx-bg px-2 py-1 text-gx-12 text-gx-text-hint">
        {field.type === "formula"
          ? "公式自动计算"
          : field.type === "rollup"
            ? "聚合自动计算"
            : field.type === "count"
              ? "计数自动计算"
              : field.type === "lookup"
                ? "查阅自动计算"
                : "系统字段只读"}
      </div>
    );
  }

  const common = "w-full rounded-gx-lg border border-gx-border bg-gx-surface px-2 py-1 text-gx-13 text-gx-text-primary focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent-bg disabled:opacity-50";

  switch (field.type) {
    case "member":
      return (
        <FieldMemberInput
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "longText":
    case "richText":
      return (
        <textarea
          autoFocus={autoFocus}
          disabled={disabled}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          rows={3}
          className={clsx(common, "resize-y")}
          placeholder="请输入"
        />
      );
    case "number":
    case "currency":
    case "percent":
    case "duration": {
      const step = field.precision ? Math.pow(0.1, field.precision) : 1;
      return (
        <input
          type="number"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value == null ? "" : Number(value)}
          step={step}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          onBlur={onBlur}
          className={common}
          placeholder="0"
        />
      );
    }
    case "checkbox":
      return (
        <label className="inline-flex items-center gap-2 text-gx-13 text-gx-text-primary">
          <input
            type="checkbox"
            disabled={disabled}
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 accent-gx-accent"
          />
          {value ? "是" : "否"}
        </label>
      );
    case "singleSelect": {
      const opts = field.options ?? [];
      return (
        <select
          autoFocus={autoFocus}
          disabled={disabled}
          value={resolveSelectOption(field, value)?.name ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          onBlur={onBlur}
          className={common}
        >
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o.id} value={o.name}>
              {o.name}
            </option>
          ))}
        </select>
      );
    }
    case "multiSelect": {
      const current = Array.isArray(value) ? (value as CellValue[]).map((v) => resolveSelectOption(field, v)?.name).filter(Boolean) as string[] : [];
      const opts = field.options ?? [];
      const toggle = (name: string) => {
        if (current.includes(name)) onChange(current.filter((n) => n !== name));
        else onChange([...current, name]);
      };
      return (
        <div className="flex flex-wrap gap-1 rounded-gx-lg border border-gx-border bg-gx-surface p-2">
          {opts.length === 0 && <span className="text-gx-12 text-gx-text-hint">无选项</span>}
          {opts.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(o.name)}
              className={clsx(
                "rounded-full px-2 py-0.5 text-gx-12 font-medium transition-colors",
                current.includes(o.name) ? "text-white" : "border border-gx-border",
              )}
              style={current.includes(o.name) ? { backgroundColor: o.color } : { color: o.color }}
            >
              {o.name}
            </button>
          ))}
        </div>
      );
    }
    case "date":
      return (
        <input
          type="date"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value ? String(value).substring(0, 10) : ""}
          onChange={(e) => onChange(e.target.value || null)}
          onBlur={onBlur}
          className={clsx(common, "[&::-webkit-clear-button]:hidden [&::-webkit-inner-spin-button]:hidden")}
        />
      );
    case "datetime":
      return (
        <input
          type="datetime-local"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value ? String(value).substring(0, 16) : ""}
          onChange={(e) => onChange(e.target.value || null)}
          onBlur={onBlur}
          className={clsx(common, "[&::-webkit-clear-button]:hidden [&::-webkit-inner-spin-button]:hidden")}
        />
      );
    case "rating": {
      const n = Number(value) || 0;
      return (
        <div className="flex items-center gap-1 text-gx-warning">
          {Array.from({ length: 5 }).map((_, i) => (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => onChange(i + 1)}
              className="inline-flex h-6 w-6 items-center justify-center"
              aria-label={`${i + 1} 星`}
            >
              <Icon name="star" size={16} className={i < n ? "opacity-100" : "opacity-25"} />
            </button>
          ))}
        </div>
      );
    }
    case "url":
      return (
        <input
          type="url"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={common}
          placeholder="https://"
        />
      );
    case "email":
      return (
        <input
          type="email"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={common}
          placeholder="name@example.com"
        />
      );
    case "phone":
      return (
        <input
          type="tel"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={common}
          placeholder="电话号码"
        />
      );
    // 详情抽屉 / 表单视图的附件字段：以前这里只有一行「请在单元格中上传」的灰底提示
    // （用户报的根因），现在换成真正的上传器——选文件、带进度上传、预览、移除都在这里。
    // baseId 缺省时由上传组件自己从路由 /base/:baseId/table/:tableId 推导，
    // 因此抽屉（DetailLayout）那几处调用点无需改动即可获得上传能力。
    case "attachment":
      return (
        <AttachmentUploader
          value={value}
          onChange={onChange}
          disabled={disabled}
          fieldId={field.id}
          baseId={attachmentContext?.baseId}
          tableId={attachmentContext?.tableId}
          recordId={attachmentContext?.recordId}
        />
      );
    case "links":
      return (
        <div className="rounded-gx-sm bg-gx-bg px-2 py-1 text-gx-12 text-gx-text-hint">
          关联关系请在单元格中维护
        </div>
      );
    case "tabs":
      return (
        <div className="rounded-gx-sm bg-gx-bg px-2 py-1 text-gx-12 text-gx-text-hint">
          选项卡字段仅用于详情页布局分组
        </div>
      );
    case "subtable":
      return (
        <div className="rounded-gx-sm bg-gx-bg px-2 py-1 text-gx-12 text-gx-text-hint">
          子表格字段仅在详情页编辑
        </div>
      );
    case "json":
      return (
        <textarea
          autoFocus={autoFocus}
          disabled={disabled}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          rows={3}
          className={clsx(common, "font-mono resize-y")}
          placeholder="{}"
        />
      );
    default:
      return (
        <input
          type="text"
          autoFocus={autoFocus}
          disabled={disabled}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={common}
          placeholder="请输入"
        />
      );
  }
}

/** 非网格视图里成员字段的只读展示。 */
function FieldMemberDisplay({ value }: { value: CellValue }) {
  const { byId } = useMemberRoster();
  return <MemberDisplay userId={value} byId={byId} />;
}

/**
 * 非网格视图里成员字段的编辑控件：点击按钮弹出成员选择面板。
 * 选中/清除即通过 onChange 写回（提交时机由外层 onBlur/保存决定）。
 */
function FieldMemberInput({
  value,
  onChange,
  disabled,
}: {
  value: CellValue;
  onChange: (v: CellValue) => void;
  disabled?: boolean;
}) {
  const { members, byId, isLoading } = useMemberRoster();
  const [open, setOpen] = useState(false);
  const current = typeof value === "string" ? value : "";
  const member = current ? byId.get(current) ?? null : null;
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-2 py-1 text-left text-gx-13 text-gx-text-primary hover:border-gx-accent disabled:opacity-50"
      >
        {member ? (
          <MemberDisplay userId={value} byId={byId} />
        ) : (
          <span className="text-gx-text-hint">点击选择成员</span>
        )}
      </button>
      {open && (
        <MemberSelect
          value={value}
          members={members}
          isLoading={isLoading}
          onCommit={(userId) => {
            onChange(userId);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

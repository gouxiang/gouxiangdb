// apps/web/src/features/designer/NumberRuleEditor.tsx
// 自动编号规则编辑器：多段组合（固定字符 / 时间 / 表单字段值 / 计数器）。
// 计数器支持补零位数与重置方式（不重置 / 按年 / 按月 / 按日 / 按指定字段值分组）。
// 设计语言：段列表为轻量卡片，段类型/字段/重置用大下拉，添加段用一个虚线「添加规则段」入口。

import type { FieldDTO, NumberRule, NumberSegment, TimeFormat, CounterReset } from "@gx/shared-types";
import { isFilterMatchSourceType } from "@gx/shared-types";
import { Input } from "../../components/ui";
import { DropdownSelect } from "../../components/settings-controls";
import { Icon } from "../../components/icons";

/** 「添加规则段」下拉的常驻占位值（不对应任何段类型，仅用于维持占位态显示） */
const ADD_TOKEN = "__add__";

export interface NumberRuleEditorProps {
  value: NumberRule | null;
  onChange: (rule: NumberRule | null) => void;
  /** 本表字段（用于「表单内字段值」段与计数器按字段重置）；仅物理可比较标量字段 */
  selfFields: FieldDTO[];
}

const TIME_FORMAT_LABEL: Record<TimeFormat, string> = {
  yyyy: "年（2026）",
  yyyyMM: "年月（202609）",
  yyyyMMdd: "年月日（20260905）",
};

const RESET_LABEL: Record<CounterReset, string> = {
  never: "不重置（全局递增）",
  year: "按年重置",
  month: "按月重置",
  day: "按日重置",
  field: "按字段值重置",
};

const SEG_TYPE_LABEL: Record<NumberSegment["type"], string> = {
  fixed: "固定字符",
  time: "时间",
  field: "表单字段值",
  counter: "计数器",
};

export function NumberRuleEditor({ value, onChange, selfFields }: NumberRuleEditorProps) {
  const segments = value?.segments ?? [];
  // 字段值段/按字段重置：仅物理可比较标量字段
  const fieldOptions = selfFields.filter((f) => isFilterMatchSourceType(f.type));

  const update = (segs: NumberSegment[]) => onChange(segs.length === 0 ? null : { segments: segs });

  const addSegment = (type: string) => {
    if (!type || type === ADD_TOKEN) return;
    let seg: NumberSegment;
    if (type === "fixed") seg = { type: "fixed", text: "" };
    else if (type === "time") seg = { type: "time", format: "yyyyMMdd" };
    else if (type === "field") seg = { type: "field", fieldId: (fieldOptions[0]?.id ?? "") as never };
    else seg = { type: "counter", digits: 4, reset: "never" };
    update([...segments, seg]);
  };

  const patch = (idx: number, p: Partial<NumberSegment>) => {
    update(segments.map((s, i) => (i === idx ? ({ ...s, ...p } as NumberSegment) : s)));
  };
  const remove = (idx: number) => update(segments.filter((_, i) => i !== idx));
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= segments.length) return;
    const copy = [...segments];
    [copy[idx], copy[j]] = [copy[j]!, copy[idx]!];
    update(copy);
  };

  const preview = buildPreview(segments);

  const addOptions = [
    { value: "fixed", label: "固定字符（如 ORD-）" },
    { value: "time", label: "时间（年 / 年月 / 年月日）" },
    { value: "field", label: "表单字段值", disabled: fieldOptions.length === 0 },
    { value: "counter", label: "计数器（递增序号）" },
  ];

  return (
    <div className="flex flex-col gap-2.5">
      {/* 段列表 */}
      <div className="flex flex-col gap-2">
        {segments.length === 0 && (
          <p className="rounded-gx-lg bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-hint">
            未配置编号规则时，编号按记录创建顺序自动生成（1、2、3…）。
          </p>
        )}
        {segments.map((seg, i) => (
          <SegmentRow
            key={i}
            seg={seg}
            selfFields={fieldOptions}
            onPatch={(p) => patch(i, p)}
            onRemove={() => remove(i)}
            onUp={() => move(i, -1)}
            onDown={() => move(i, 1)}
            canUp={i > 0}
            canDown={i < segments.length - 1}
          />
        ))}
      </div>

      {/* 添加段：全宽大下拉，选择即追加 */}
      <DropdownSelect
        value=""
        placeholder="＋ 添加规则段"
        options={addOptions}
        onChange={(v) => addSegment(v)}
      />

      {/* 预览 */}
      <div className="rounded-gx-lg bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-secondary">
        预览：<span className="font-mono text-gx-13 font-medium text-gx-text-primary">{preview || "—"}</span>
      </div>
      <p className="text-gx-11 leading-relaxed text-gx-text-hint">
        编号在记录创建时按规则生成并固定，不随后续删除/排序变化。计数器「按字段值重置」表示：本表某字段值每重复出现一次，该值对应分组内序号递增（如同一个客户名下第 1、2、3 条）。
      </p>
    </div>
  );
}

function SegmentRow({
  seg,
  selfFields,
  onPatch,
  onRemove,
  onUp,
  onDown,
  canUp,
  canDown,
}: {
  seg: NumberSegment;
  selfFields: FieldDTO[];
  onPatch: (p: Partial<NumberSegment>) => void;
  onRemove: () => void;
  onUp: () => void;
  onDown: () => void;
  canUp: boolean;
  canDown: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-gx-lg border border-gx-border bg-gx-surface p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-gx-accent-bg px-1.5 py-0.5 text-gx-11 font-medium text-gx-accent">{SEG_TYPE_LABEL[seg.type]}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" onClick={onUp} disabled={!canUp} className="rounded p-0.5 text-gx-text-hint hover:text-gx-accent disabled:opacity-30" title="上移">
            <Icon name="chevronUp" size={14} />
          </button>
          <button type="button" onClick={onDown} disabled={!canDown} className="rounded p-0.5 text-gx-text-hint hover:text-gx-accent disabled:opacity-30" title="下移">
            <Icon name="chevronDown" size={14} />
          </button>
          <button type="button" onClick={onRemove} className="rounded p-0.5 text-gx-text-hint hover:text-gx-danger" title="删除">
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      {seg.type === "fixed" && (
        <Input value={seg.text} onChange={(e) => onPatch({ text: e.target.value })} placeholder="固定字符，如：ORD-" />
      )}

      {seg.type === "time" && (
        <DropdownSelect
          value={seg.format}
          onChange={(v) => onPatch({ format: v as TimeFormat })}
          options={(Object.keys(TIME_FORMAT_LABEL) as TimeFormat[]).map((f) => ({ value: f, label: TIME_FORMAT_LABEL[f] }))}
        />
      )}

      {seg.type === "field" && (
        <DropdownSelect
          value={(seg.fieldId as string) ?? ""}
          placeholder="选择表单字段"
          onChange={(v) => onPatch({ fieldId: v as never })}
          options={[
            ...(selfFields.length === 0 ? [{ value: "", label: "暂无可引用字段" }] : []),
            ...selfFields.map((f) => ({ value: f.id, label: f.name, disabled: false })),
          ]}
        />
      )}

      {seg.type === "counter" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-gx-12 text-gx-text-secondary">序号位数</span>
            <Input
              type="number"
              min={1}
              max={10}
              value={String(seg.digits ?? 4)}
              onChange={(e) => onPatch({ digits: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
              className="h-8 w-20"
            />
            <span className="text-gx-11 text-gx-text-hint">（如 4 位 → 0001）</span>
          </div>
          <DropdownSelect
            value={seg.reset}
            onChange={(v) => onPatch({ reset: v as CounterReset, resetFieldId: v === "field" ? seg.resetFieldId : undefined })}
            options={(Object.keys(RESET_LABEL) as CounterReset[]).map((r) => ({ value: r, label: RESET_LABEL[r] }))}
          />
          {seg.reset === "field" && (
            <DropdownSelect
              value={(seg.resetFieldId as string) ?? ""}
              placeholder="选择分组字段"
              onChange={(v) => onPatch({ resetFieldId: v as never })}
              options={selfFields.map((f) => ({ value: f.id, label: f.name }))}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** 生成一个示例预览串（counter 用 001、field 用占位、时间用当前日期） */
function buildPreview(segments: NumberSegment[]): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return segments.map((seg) => {
    if (seg.type === "fixed") return seg.text ?? "";
    if (seg.type === "time") return seg.format === "yyyy" ? String(y) : seg.format === "yyyyMM" ? `${y}${m}` : `${y}${m}${d}`;
    if (seg.type === "field") return "{字段值}";
    const digits = seg.digits ?? 4;
    return "0".repeat(Math.max(0, digits - 1)) + "1";
  }).join("");
}

export default NumberRuleEditor;

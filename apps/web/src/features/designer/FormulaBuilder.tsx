// apps/web/src/features/designer/FormulaBuilder.tsx
// 公式构建器：字段/函数插入 + 实时括号配平与引用校验（前端校验，不请求后端）

import { useRef, useState } from "react";
import { useLookupTargets } from "../../api/hooks";
import type { FieldDTO } from "@gx/shared-types";
import { FieldIcon, Textarea } from "../../components/ui";

export interface FormulaBuilderProps {
  value: string;
  fields: FieldDTO[];
  onChange: (next: string) => void;
  /** 紧凑模式：用于右侧设置面板等窄空间（输入框更矮、字段/函数列表折叠限高） */
  compact?: boolean;
}

const FUNCTIONS: { group: string; items: string[] }[] = [
  { group: "逻辑", items: ["IF", "SWITCH", "AND", "OR", "NOT"] },
  { group: "文本", items: ["CONCAT", "TRIM", "UPPER", "LOWER", "LEN", "LEFT", "RIGHT", "REPLACE", "SUBSTR", "REPT", "SEARCH"] },
  { group: "数学", items: ["ROUND", "CEILING", "FLOOR", "ABS", "MIN", "MAX", "SQRT", "POWER", "MOD", "INT", "SUM", "AVERAGE"] },
  { group: "日期", items: ["NOW", "TODAY", "DATETIME_DIFF", "DATEADD"] },
];

/** 提取所有 {xxx} 引用（支持点引用 a.b） */
function extractRefs(formula: string): string[] {
  const out: string[] = [];
  const re = /\{((?:[^{}]|\.)*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

export default function FormulaBuilder({ value, fields, onChange, compact = false }: FormulaBuilderProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [subMenuFor, setSubMenuFor] = useState<string | null>(null);
  const [showFns, setShowFns] = useState(!compact);

  const fieldNameSet = new Set(fields.map((f) => f.name));

  // 校验
  const openBraces = (value.match(/\{/g) ?? []).length;
  const closeBraces = (value.match(/\}/g) ?? []).length;
  const braceOk = openBraces === closeBraces;
  const refs = extractRefs(value);
  const unknownRefs = refs.filter((r) => {
    const head = r.split(".")[0] ?? "";
    return !fieldNameSet.has(head);
  });
  const hasRefError = unknownRefs.length > 0;
  const errorMsg = !braceOk
    ? `括号未闭合：{ 与 } 数量不一致（${openBraces} / ${closeBraces}）`
    : hasRefError
      ? `未知字段引用：${unknownRefs.join("、")}`
      : null;

  // 在光标处插入文本
  const insertAtCursor = (text: string) => {
    const ta = taRef.current;
    if (!ta) {
      onChange(value + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const insertField = (name: string) => insertAtCursor(`{${name}}`);
  const insertSub = (linkName: string, subName: string) => {
    insertAtCursor(`{${linkName}.${subName}}`);
    setSubMenuFor(null);
  };
  const insertFn = (fn: string) => insertAtCursor(`${fn}()`);

  const linkFields = fields.filter((f) => f.type === "links");

  return (
    <div className="flex flex-col gap-2.5">
      <Textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={compact ? 2 : 4}
        className={compact ? "font-mono text-gx-12" : "font-mono"}
        placeholder={"例如：{数量} * {单价}"}
      />

      {errorMsg ? (
        <div className="rounded-gx-sm bg-gx-danger-bg px-2 py-1 text-gx-11 text-gx-danger">{errorMsg}</div>
      ) : (
        <div className="text-gx-11 text-gx-text-hint">可用字段 {fields.length} 个，引用 {refs.length} 处。</div>
      )}

      {/* 字段列表 */}
      <div>
        <div className="mb-1 text-gx-12 font-medium text-gx-text-secondary">插入字段</div>
        <div className={compact ? "flex max-h-24 flex-wrap gap-1.5 overflow-y-auto rounded-gx-sm border border-gx-border bg-gx-bg/40 p-1.5" : "flex flex-wrap gap-1.5"}>
          {fields.length === 0 && <span className="text-gx-11 text-gx-text-hint">无可用字段</span>}
          {fields.map((f) => (
            <div key={f.id} className="relative inline-flex">
              <button
                type="button"
                onClick={() => insertField(f.name)}
                className="inline-flex items-center gap-1 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-0.5 text-gx-12 text-gx-text-primary hover:bg-gx-bg"
              >
                <FieldIcon type={f.type} size={12} />
                {f.name}
              </button>
              {f.type === "links" && (
                <button
                  type="button"
                  onClick={() => setSubMenuFor(subMenuFor === f.id ? null : f.id)}
                  className="ml-0.5 inline-flex h-6 w-4 items-center justify-center rounded-gx-sm border border-gx-border bg-gx-surface text-gx-11 text-gx-text-tertiary hover:bg-gx-bg"
                  title="插入子字段"
                >
                  ⌄
                </button>
              )}
              {subMenuFor === f.id && <SubFieldMenu field={f} onPick={insertSub} />}
            </div>
          ))}
        </div>
      </div>

      {/* 函数列表（紧凑模式下折叠，点开后限高滚动） */}
      {compact ? (
        <div>
          <button
            type="button"
            onClick={() => setShowFns((v) => !v)}
            className="inline-flex items-center gap-1 text-gx-12 font-medium text-gx-accent hover:underline"
          >
            {showFns ? "收起函数列表" : "展开函数列表"}
          </button>
          {showFns && (
            <div className="mt-1.5 max-h-32 space-y-2 overflow-y-auto rounded-gx-sm border border-gx-border bg-gx-bg/40 p-2">
              {FUNCTIONS.map((grp) => (
                <div key={grp.group}>
                  <div className="mb-1 text-gx-11 text-gx-text-tertiary">{grp.group}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {grp.items.map((fn) => (
                      <button
                        key={fn}
                        type="button"
                        onClick={() => insertFn(fn)}
                        className="rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-0.5 font-mono text-gx-12 text-gx-text-primary hover:bg-gx-bg"
                      >
                        {fn}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="mb-1 text-gx-12 font-medium text-gx-text-secondary">插入函数</div>
          <div className="flex flex-col gap-2">
            {FUNCTIONS.map((grp) => (
              <div key={grp.group}>
                <div className="mb-1 text-gx-11 text-gx-text-tertiary">{grp.group}</div>
                <div className="flex flex-wrap gap-1.5">
                  {grp.items.map((fn) => (
                    <button
                      key={fn}
                      type="button"
                      onClick={() => insertFn(fn)}
                      className="rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1 font-mono text-gx-12 text-gx-text-primary hover:bg-gx-bg"
                    >
                      {fn}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-gx-sm bg-gx-bg px-2 py-1 text-gx-11 text-gx-text-hint">
        示例：<code className="font-mono">{"{单价} * {数量}"}</code>；关联子字段：<code className="font-mono">{"{客户.名称}"}</code>
      </div>
    </div>
  );
}

// 关联字段的子字段下拉
function SubFieldMenu({
  field,
  onPick,
}: {
  field: FieldDTO;
  onPick: (linkName: string, subName: string) => void;
}) {
  const { data } = useLookupTargets(field.id);
  const subs = data ?? [];
  return (
    <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-gx-lg border border-gx-border bg-gx-surface p-1 shadow-lg">
      <div className="px-2 py-1 text-gx-11 text-gx-text-hint">插入关联字段取值</div>
      {subs.length === 0 ? (
        <div className="px-2 py-1 text-gx-11 text-gx-text-hint">无子字段</div>
      ) : (
        subs.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(field.name, s.name)}
            className="flex w-full items-center gap-1.5 rounded-gx-sm px-2 py-1 text-left text-gx-12 text-gx-text-primary hover:bg-gx-bg"
          >
            <FieldIcon type={s.type} size={12} />
            {s.name}
          </button>
        ))
      )}
    </div>
  );
}

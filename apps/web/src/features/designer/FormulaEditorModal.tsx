// apps/web/src/features/designer/FormulaEditorModal.tsx
// 三栏公式编辑器弹窗（复刻 NocoDB「通过公式计算」）：
//   左栏 函数分类列表（悬停展示用途/参数/示例）
//   中栏 字段列表（关联/子表格字段展开为「子表格标题·字段名」，点插 {关联.子字段} 点引用）
//   右栏 公式编辑区 + 实时校验 + 当前函数说明卡
// 通过 createPortal 渲染到 body。
// 跨表数据统一走点引用 {关联字段.子字段}：多条关联记录自动聚合为列表，
// 可直接喂给 SUM/AVERAGE/MIN/MAX/CONCAT/LEN/FIRST/LAST 等常规函数，无专用跨表函数。

import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import type { FieldDTO } from "@gx/shared-types";
import {
  FORMULA_FUNCTIONS,
  FORMULA_CATEGORY_LABEL,
  getFormulaFn,
  type FormulaFnDef,
  type FormulaCategory,
} from "@gx/shared-types";
import { useLookupTargets } from "../../api/hooks";
import { Button, FieldIcon } from "../../components/ui";
import { Icon } from "../../components/icons";

export interface FormulaEditorModalProps {
  value: string;
  fields: FieldDTO[];
  onClose: () => void;
  onConfirm: (formula: string) => void;
}

const CATEGORY_ORDER: FormulaCategory[] = ["common", "logic", "text", "math", "date"];

export function FormulaEditorModal({ value, fields, onClose, onConfirm }: FormulaEditorModalProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  const [fnQuery, setFnQuery] = useState("");
  const [fieldQuery, setFieldQuery] = useState("");
  const [activeCat, setActiveCat] = useState<FormulaCategory>("common");
  const [hoverFn, setHoverFn] = useState<FormulaFnDef | null>(null);

  const linkFields = useMemo(
    () => fields.filter((f) => f.type === "links" || f.type === "subtable"),
    [fields],
  );

  const insertAtCursor = (text: string) => {
    const ta = taRef.current;
    if (!ta) { setDraft((d) => d + text); return; }
    const start = ta.selectionStart ?? draft.length;
    const end = ta.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const insertField = (name: string) => insertAtCursor(`{${name}}`);
  const insertDotRef = (linkName: string, subName: string) => insertAtCursor(`{${linkName}.${subName}}`);

  const clickFn = (fn: FormulaFnDef) => {
    setHoverFn(fn);
    insertAtCursor(`${fn.name}( )`);
  };

  // 过滤
  const fns = useMemo(() => {
    const q = fnQuery.trim().toLowerCase();
    return FORMULA_FUNCTIONS.filter(
      (f) => f.category === activeCat && (!q || f.name.toLowerCase().includes(q) || f.description.includes(fnQuery.trim())),
    );
  }, [fnQuery, activeCat]);

  const visibleLocalFields = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    return fields.filter((f) => !q || f.name.toLowerCase().includes(q));
  }, [fields, fieldQuery]);

  // ---- 实时校验（memo：仅公式/字段变化时重算，hover 函数不触发重复正则解析）----
  const errors = useMemo(() => validateFormula(draft, fields), [draft, fields]);

  // z-[820]：本弹窗由通用 Modal(z-[800]) 内的「设置公式」二级触发，必须高于 800 才不被父弹窗压住；
  // 低于 Popover z-[900] / Toast z-[1000]（见 z token 约定）。
  // 固定高度 760px（92vh 封顶）：函数说明卡/跨表构建器/校验信息均在弹窗内部槽位伸缩，
  // 整窗高度不随 hover 的函数说明长短反复跳动。
  return createPortal(
    <div className="fixed inset-0 z-[820] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="relative flex h-[760px] max-h-[92vh] w-full flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-xl" style={{ maxWidth: 1120 }}>
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-gx-separator px-5 py-3">
          <div className="flex items-center gap-2">
            <Icon name="formula" size={16} className="text-gx-accent" />
            <span className="text-gx-15 font-semibold text-gx-text-primary">通过公式计算</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-gx-text-hint hover:bg-gx-bg">
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* 三栏 */}
        <div className="flex min-h-0 flex-1">
          {/* 左：函数 */}
          <div className="flex w-56 flex-col border-r border-gx-separator">
            <div className="border-b border-gx-separator p-2">
              <div className="flex items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-bg/50 px-2 py-1">
                <Icon name="search" size={12} className="text-gx-text-hint" />
                <input value={fnQuery} onChange={(e) => setFnQuery(e.target.value)} placeholder="搜索函数" className="w-full bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {CATEGORY_ORDER.map((cat) => {
                const catFns = FORMULA_FUNCTIONS.filter((f) => f.category === cat);
                const active = activeCat === cat;
                return (
                  <div key={cat}>
                    <button
                      type="button"
                      onClick={() => setActiveCat(cat)}
                      className={clsx(
                        "flex w-full items-center gap-1 rounded-gx-sm px-2 py-1 text-left text-gx-12 font-medium text-gx-text-secondary",
                        active && "bg-gx-accent-bg",
                      )}
                    >
                      <Icon name={active ? "chevronDown" : "chevronRight"} size={11} />
                      {FORMULA_CATEGORY_LABEL[cat]}
                    </button>
                    {active && (
                      <div className="mb-1 ml-2 flex flex-col">
                        {fns.length === 0 && <div className="px-2 py-1 text-gx-11 text-gx-text-hint">无匹配函数</div>}
                        {fns.map((fn) => (
                          <button
                            key={fn.name}
                            type="button"
                            onMouseEnter={() => setHoverFn(fn)}
                            onClick={() => clickFn(fn)}
                            className={clsx(
                              "rounded-gx-sm px-2 py-1 text-left font-mono text-gx-12 text-gx-text-primary hover:bg-gx-accent-bg",
                              hoverFn?.name === fn.name && "bg-gx-accent-bg",
                            )}
                          >
                            {fn.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 中：字段 */}
          <div className="flex w-64 flex-col border-r border-gx-separator">
            <div className="border-b border-gx-separator p-2">
              <div className="flex items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-bg/50 px-2 py-1">
                <Icon name="search" size={12} className="text-gx-text-hint" />
                <input value={fieldQuery} onChange={(e) => setFieldQuery(e.target.value)} placeholder="搜索字段" className="w-full bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {visibleLocalFields.filter((f) => f.type !== "links" && f.type !== "subtable").map((f) => (
                <button key={f.id} type="button" onClick={() => insertField(f.name)}
                  className="flex w-full items-center gap-1.5 rounded-gx-sm px-2 py-1 text-left text-gx-12 text-gx-text-primary hover:bg-gx-accent-bg">
                  <FieldIcon type={f.type} size={12} />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
              {linkFields.map((lf) => (
                <LinkFieldGroup key={lf.id} linkField={lf} onInsertField={insertField} onInsertSub={insertDotRef} fieldQuery={fieldQuery} />
              ))}
            </div>
          </div>

          {/* 右：编辑区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-gx-separator px-3 py-1.5">
              <span className="font-mono text-gx-12 text-gx-text-secondary">公式 =</span>
              <button type="button" onClick={() => { navigator.clipboard?.writeText(draft).catch(() => {}); }} className="inline-flex items-center gap-1 text-gx-11 text-gx-text-secondary hover:text-gx-accent">
                <Icon name="copy" size={12} /> 复制
              </button>
            </div>
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={7}
              spellCheck={false}
              className="h-40 w-full shrink-0 resize-none border-b border-gx-separator bg-gx-bg/30 px-3 py-2 font-mono text-gx-13 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
              placeholder="在左侧选择函数或字段变量，且在英文输入法下编辑"
            />

            {/* 点引用用法提示：跨表统一走 {关联字段.子字段} */}
            <div className="shrink-0 border-b border-gx-separator bg-gx-accent-bg/20 px-3 py-1.5 text-gx-11 leading-relaxed text-gx-text-secondary">
              跨表计算：在中栏展开子表格/关联字段，插入形如 <span className="font-mono text-gx-accent">{"{订单明细.金额}"}</span> 的点引用；多条记录自动聚合成列表，可直接用
              <span className="font-mono"> SUM / AVERAGE / MIN / MAX / CONCAT / LEN / FIRST / LAST</span> 计算。
            </div>

            {/* 校验结果：固定单行高度槽位，错误增多时槽位内部滚动，不改变整体布局 */}
            <div className="h-7 shrink-0 overflow-y-auto px-3 py-1.5">
              {errors.length > 0 ? (
                errors.slice(0, 1).map((e, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-gx-11 text-gx-danger">
                    <Icon name="close" size={11} /> {e}{errors.length > 1 ? `（共 ${errors.length} 项错误）` : ""}
                  </div>
                ))
              ) : draft.trim() ? (
                <div className="flex items-center gap-1.5 text-gx-11 text-gx-success">
                  <Icon name="check" size={11} /> 公式校验通过
                </div>
              ) : (
                <div className="text-gx-11 text-gx-text-hint">公式为空</div>
              )}
            </div>

            {/* 函数说明卡：常驻固定槽位（占满右栏剩余高度），hover 仅替换槽位内容，
                从结构上消除「移入/移出函数 → 整块挂载卸载 → 弹窗高度反复跳动」的闪烁 */}
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-gx-separator bg-gx-bg/40 px-3 py-2">
              {hoverFn ? (
                <>
                <div className="mb-1 font-mono text-gx-12 font-semibold text-gx-text-primary">{hoverFn.name}</div>
                <div className="mb-1 font-mono text-gx-11 text-gx-accent">{hoverFn.signature}</div>
                <div className="mb-1.5 text-gx-11 leading-relaxed text-gx-text-secondary">{hoverFn.description}</div>
                <div className="rounded-gx-sm bg-gx-surface px-2 py-1 font-mono text-gx-11 whitespace-pre-line text-gx-text-secondary">
                  {hoverFn.example}
                </div>
                </>
              ) : (
                <div className="flex h-full items-center justify-center text-gx-11 text-gx-text-hint">
                  将鼠标悬停在左侧函数上查看用法说明
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-end gap-2 border-t border-gx-separator px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={errors.length > 0 || !draft.trim()} onClick={() => onConfirm(draft)}>
            确定
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 关联/子表格字段分组：标题可点插入 {字段名}，子字段以「子表格标题·字段名」展示，点插 {标题.子字段} */
function LinkFieldGroup({
  linkField,
  onInsertField,
  onInsertSub,
  fieldQuery,
}: {
  linkField: FieldDTO;
  onInsertField: (name: string) => void;
  onInsertSub: (linkName: string, subName: string) => void;
  fieldQuery: string;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useLookupTargets(linkField.id);
  const subs = (data ?? []).filter((s) => s.type !== "tabs" && s.type !== "subtable");
  const q = fieldQuery.trim().toLowerCase();
  const visibleSubs = subs.filter((s) => !q || s.name.toLowerCase().includes(q));
  return (
    <div>
      <div className="flex items-center">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-6 items-center justify-center py-1 text-gx-text-hint hover:text-gx-accent">
          <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
        </button>
        <button type="button" onClick={() => onInsertField(linkField.name)}
          className="flex flex-1 items-center gap-1.5 rounded-gx-sm px-1 py-1 text-left text-gx-12 font-medium text-gx-text-primary hover:bg-gx-accent-bg">
          <FieldIcon type={linkField.type} size={12} />
          <span className="truncate">{linkField.name}</span>
        </button>
      </div>
      {open && (
        <div className="ml-5 flex flex-col border-l border-gx-separator pl-1">
          {visibleSubs.length === 0 && <div className="px-2 py-1 text-gx-11 text-gx-text-hint">无子字段</div>}
          {visibleSubs.map((s) => (
            <button key={s.id} type="button" onClick={() => onInsertSub(linkField.name, s.name)}
              className="flex items-center gap-1.5 rounded-gx-sm px-2 py-1 text-left text-gx-12 text-gx-text-secondary hover:bg-gx-accent-bg" title={`${linkField.name} · ${s.name}`}>
              <FieldIcon type={s.type} size={11} />
              <span className="truncate">{linkField.name} · {s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 实时校验（前端轻量版；后端 safeEvaluateFormula 为最终权威）----

function extractRefs(formula: string): string[] {
  const out: string[] = [];
  const re = /\{((?:[^{}]|\.)*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) out.push(m[1]!);
  return out;
}

function extractCalls(formula: string): { name: string; args: string }[] {
  const out: { name: string; args: string }[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    const name = m[1]!;
    // 找到匹配的右括号，截取参数串（粗略，按括号配平）
    let depth = 1;
    let i = re.lastIndex;
    for (; i < formula.length; i++) {
      if (formula[i] === "(") depth++;
      else if (formula[i] === ")") { depth--; if (depth === 0) break; }
    }
    out.push({ name, args: formula.slice(re.lastIndex, i) });
  }
  return out;
}

/** 粗略切分顶层参数（逗号在括号/花括号深度 0 处） */
function splitTopArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function validateFormula(formula: string, fields: FieldDTO[]): string[] {
  const errors: string[] = [];
  const f = formula.trim();
  if (!f) return errors;

  // 括号配平
  const openB = (f.match(/\{/g) ?? []).length;
  const closeB = (f.match(/\}/g) ?? []).length;
  if (openB !== closeB) errors.push(`字段引用花括号不配对（{ ${openB} 个，} ${closeB} 个）`);
  const openP = (f.match(/\(/g) ?? []).length;
  const closeP = (f.match(/\)/g) ?? []).length;
  if (openP !== closeP) errors.push(`函数括号不配对（( ${openP} 个，) ${closeP} 个）`);

  // 字段引用合法性
  const names = new Set(fields.map((x) => x.name));
  for (const ref of extractRefs(f)) {
    const head = ref.split(".")[0] ?? "";
    if (!names.has(head)) errors.push(`未知字段引用：{${ref}}`);
  }

  // 函数存在性 + 参数个数
  const calls = extractCalls(f);
  for (const c of calls) {
    const def = getFormulaFn(c.name);
    if (!def) { errors.push(`未知函数：${c.name.toUpperCase()}`); continue; }
    const argc = splitTopArgs(c.args).length;
    const { min, max } = def.arity;
    if (argc < min || (max !== null && argc > max)) {
      errors.push(`${def.name} 参数个数应为 ${min}${max === null ? " 个以上" : max === min ? ` 个（当前 ${argc}）` : `~${max} 个（当前 ${argc}）`}`);
    }
  }
  return errors;
}

export default FormulaEditorModal;

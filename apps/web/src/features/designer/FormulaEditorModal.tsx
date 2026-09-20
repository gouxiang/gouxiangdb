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
import { Button, FieldIcon, toast } from "../../components/ui";
import { COPY_FAIL_HINT_TEXT, copyText } from "../../lib/clipboard";
import { Icon } from "../../components/icons";

export interface FormulaEditorModalProps {
  value: string;
  fields: FieldDTO[];
  onClose: () => void;
  onConfirm: (formula: string) => void;
}

const CATEGORY_ORDER: FormulaCategory[] = ["common", "logic", "text", "math", "date"];

/**
 * 函数选择器的可见集合：按分类 + 关键词过滤，并排除别名条目（`aliasOf`）。
 * 别名（当前只有 OR_F → OR）在后端与 OR 共用同一份实现，列表里两朵并排会让用户
 * 以为是不同函数，故只展示规范名 OR。注意这里纯做「展示过滤」，不动
 * FORMULA_FUNCTIONS / getFormulaFn，因此手写的 OR_F 公式校验结果不变。
 * 导出供单测。
 */
export function pickableFns(cat: FormulaCategory, query: string): FormulaFnDef[] {
  const q = query.trim().toLowerCase();
  return FORMULA_FUNCTIONS.filter(
    (f) =>
      !f.aliasOf &&
      f.category === cat &&
      (!q || f.name.toLowerCase().includes(q) || f.description.includes(query.trim())),
  );
}

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

  // 过滤（H-149）：别名条目（如 OR_F，与 OR 共用同一份实现）不在选择器里单独展示，
  // 否则用户会以为是两个不同的函数。它仍留在 FORMULA_FUNCTIONS 中，下方
  // validateFormula 走 getFormulaFn 校验，手写的 OR_F 公式照旧被接受。
  const fns = useMemo(() => pickableFns(activeCat, fnQuery), [fnQuery, activeCat]);

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
                const catFns = pickableFns(cat, "");
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
              {/* 原先静默吞错（点了没反应也不知道成败），现改为成功/失败都给明确 toast。 */}
              <button type="button" onClick={() => { void copyText(draft).then((ok) => {
                if (ok) toast("公式已复制", "success");
                else toast(COPY_FAIL_HINT_TEXT, "error");
              }); }} className="inline-flex items-center gap-1 text-gx-11 text-gx-text-secondary hover:text-gx-accent">
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

/**
 * 非法字符扫描：与后端 Tokenizer（apps/api/src/domain/formula.ts）可接受字符集对齐。
 * 后端对无法识别的字符直接抛「公式错误：意外字符 'x' 位置 n」，但那是保存时才报的技术文案，
 * 用户在编辑器里看不到任何提示，会以为已保存。这里在输入期就拦住。
 * 跳过规则：字符串字面量（'…' / "…"）与字段引用 {…} 内部不做字符判定（字段名可为任意文字）。
 * 竖线特殊：`||`（或）合法，单个 `|` 非法。
 */
function findIllegalChars(formula: string): { ch: string; pos: number }[] {
  const bad: { ch: string; pos: number }[] = [];
  const allowed = new Set("0123456789_.+-*/%=!<>&|(){},'\" ".split(""));
  let i = 0;
  while (i < formula.length) {
    const c = formula[i]!;
    // 字符串字面量：整段跳过
    if (c === "'" || c === '"') {
      const end = formula.indexOf(c, i + 1);
      i = end === -1 ? formula.length : end + 1;
      continue;
    }
    // 字段引用：整段跳过
    if (c === "{") {
      const end = formula.indexOf("}", i + 1);
      i = end === -1 ? formula.length : end + 1;
      continue;
    }
    if (c === "|") {
      if (formula[i + 1] === "|") { i += 2; continue; }
      bad.push({ ch: c, pos: i });
      i += 1;
      continue;
    }
    if (!allowed.has(c) && !/[\p{L}]/u.test(c)) bad.push({ ch: c, pos: i });
    i += 1;
  }
  return bad;
}

/** 导出供单测（纯函数：只依赖传入的公式串与字段名清单） */
export function validateFormula(formula: string, fields: FieldDTO[]): string[] {
  const errors: string[] = [];
  const f = formula.trim();
  if (!f) return errors;

  // 非法字符 / 非法竖线（后端 tokenizer 会直接报「意外字符」，保存才失败，故前置拦截）
  for (const b of findIllegalChars(f)) {
    errors.push(
      b.ch === "|"
        ? `公式含不支持的写法「|」（位置 ${b.pos + 1}）：「或」运算请写成 ||`
        : `公式含不支持的字符「${b.ch}」（位置 ${b.pos + 1}）：只支持 + - * / % & || = != < > ( ) 等运算符与 {字段名} 字段引用`,
    );
  }

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

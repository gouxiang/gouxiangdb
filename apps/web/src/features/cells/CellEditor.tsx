// 单元格编辑器（点击/双击进入编辑态）
// 按字段类型提供对应编辑控件，支持 Enter 提交 / Esc 取消 / Tab 提交并移动。
// 计算字段与系统字段不进入编辑态（由上层 CellRenderer 拦截）。

import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { evalFilter } from "@gx/shared-types";
import type {
  CellValue,
  FieldDTO,
  LinkRefDTO,
  PermissionSet,
  TableIdT,
  RecordIdT,
} from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Input, Textarea, Popover, Spinner, toast } from "../../components/ui";
import { useLinkCandidates } from "../../api/records-paging-hooks";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { LINK_NARROW_TEXT } from "../common/ResultNotice";
import { formatCell, isEmptyValue, resolveSelectOption } from "./format";
import { MemberSelect, useMemberRoster } from "../contacts/member-roster";

export interface CellEditorProps {
  value: CellValue;
  field: FieldDTO;
  allFields?: FieldDTO[];
  /** 当前行记录的全部字段值（用于关联筛选「匹配字段」取本表值） */
  recordFields?: Record<string, CellValue>;
  permissions: PermissionSet;
  // 提交下一个值；move 指示 GridView 提交后如何移动光标（默认不移动）
  onCommit: (next: CellValue, move?: "down" | "right" | "none") => void;
  onCancel: () => void;
}

const TEXT_TYPES = new Set([
  "singleLineText",
  "url",
  "email",
  "phone",
  "json",
]);

const NUMERIC_TYPES = new Set(["number", "currency", "percent", "duration"]);

export function CellEditor(props: CellEditorProps) {
  const { field } = props;

  // 计算字段 / 系统字段理论上不会进入编辑态，做一道保险
  if (["formula", "rollup", "count", "lookup", "autoNumber", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"].includes(field.type)) {
    return null;
  }

  switch (field.type) {
    case "longText":
      return <LongTextEditor {...props} />;
    case "number":
    case "currency":
    case "percent":
    case "duration":
      return <NumericEditor {...props} />;
    case "checkbox":
      return <CheckboxEditor {...props} />;
    case "singleSelect":
      return <SingleSelectEditor {...props} />;
    case "multiSelect":
      return <MultiSelectEditor {...props} />;
    case "date":
    case "datetime":
      return <DateEditor {...props} />;
    case "rating":
      return <RatingEditor {...props} />;
    case "member":
      return <MemberCellEditor {...props} />;
    case "links":
      return <LinksEditor {...props} />;
    case "attachment":
      return <AttachmentEditor {...props} />;
    default:
      if (TEXT_TYPES.has(field.type)) return <TextEditor {...props} />;
      // 兜底：文本编辑
      return <TextEditor {...props} />;
  }
}

// ============ 文本 ============
function TextEditor({ value, field, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(typeof value === "string" ? value : value == null ? "" : String(value));
  // 提交/取消后置位，避免随后 input 卸载触发的 blur 再发一次 PATCH（Enter 与 blur 双发）
  const doneRef = useRef(false);
  const finish = (fn: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <Input
      ref={ref}
      value={draft}
      placeholder={field.type === "url" ? "https://" : field.type === "email" ? "name@example.com" : ""}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        // IME 组词期间 Enter/Tab 只用于选候选词，不提交
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(() => onCommit(draft, "down"));
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(() => onCommit(draft, "right"));
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(onCancel);
        }
      }}
      onBlur={() => {
        if (!doneRef.current) onCommit(draft);
      }}
    />
  );
}

// ============ 长文本 ============
function LongTextEditor({ value, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const doneRef = useRef(false);
  const finish = (fn: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };

  useEffect(() => {
    ref.current?.focus();
    // 光标移到末尾
    const len = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(len, len);
  }, []);

  return (
    <Textarea
      ref={ref}
      value={draft}
      className="h-full"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        // Cmd/Ctrl+Enter 提交，否则换行
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish(() => onCommit(draft, "down"));
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(onCancel);
        }
      }}
      onBlur={() => {
        if (!doneRef.current) onCommit(draft);
      }}
    />
  );
}

// ============ 数字 ============
function NumericEditor({ value, field, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value == null || value === "" ? "" : String(value));
  const doneRef = useRef(false);
  // 最后一次输入动作的 inputType，用于区分「用户主动删除」与「非法输入被浏览器清空」。
  // 真机实测（Chromium 133 / WebKit 均一致）：
  //   - 敲 abc（全选后）：input 事件 inputType="insertText"、data=""、value=""、badInput=false
  //   - 敲 1e / - 等半成品数字：inputType="insertText"、value=""、badInput=true
  //   - 按 Backspace/Delete：inputType="deleteContentBackward"/"deleteContentForward"
  // 即 badInput 只在半成品数字上为 true，纯字母场景靠它拦不住，必须用 inputType 判。
  const lastInputTypeRef = useRef("");
  const finish = (fn: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const submit = (move: "down" | "right" | "none" = "none") => {
    // Enter 提交后再触发 blur 时不再重复提交（doneRef 只在真正落地后才置位）
    if (doneRef.current) return;
    // 非法输入保护：`<input type="number">` 会吞掉不成数字的输入 —— 选中原值后敲 abc，
    // 浏览器把选区替换成空（value 变 ""），若照下面的「空串 → null」提交，就会把原来的
    // 42 静默清成「—」且毫无提示，用户会以为数据丢了。
    // 判定口径：当前为空 + 原本有值 + 最后一次动作不是删除 ⇒ 是被浏览器吞掉的非法输入。
    // 命中时按 Esc 语义放弃本次编辑（保留原值）并给出提示；主动删除清空则照旧放行。
    const hadValue = !(value == null || value === "");
    const emptiedByBadInput =
      draft.trim() === "" &&
      hadValue &&
      lastInputTypeRef.current !== "" &&
      !lastInputTypeRef.current.startsWith("delete");
    if (emptiedByBadInput) {
      finish(onCancel);
      toast("请输入数字，已保留原值", "error");
      return;
    }
    doneRef.current = true;
    // 空串 → null（清空）
    if (draft.trim() === "") {
      onCommit(null, move);
      return;
    }
    const num = Number(draft);
    onCommit(isNaN(num) ? draft : num, move);
  };

  return (
    <Input
      ref={ref}
      type="number"
      value={draft}
      className="text-right tabular-nums"
      onChange={(e) => {
        lastInputTypeRef.current = (e.nativeEvent as InputEvent).inputType ?? "";
        setDraft(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit("down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          submit("right");
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(onCancel);
        }
      }}
      onBlur={() => {
        if (!doneRef.current) submit();
      }}
    />
  );
}

// 复选框：只读展示当前值。翻转的唯一权威入口是单元格单击（GridView.onCellClick）；
// 这里绝不在挂载时 onCommit(!value)——双击/键盘进入若再翻转会产生重复、方向相反的 PATCH。
function CheckboxEditor({ value }: CellEditorProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <span
        className={clsx(
          "inline-flex h-4 w-4 items-center justify-center rounded border",
          value ? "border-gx-accent bg-gx-accent text-white" : "border-gx-border",
        )}
      >
        {value ? <Icon name="check" size={12} /> : null}
      </span>
    </div>
  );
}

// ============ 单选 ============
function SingleSelectEditor({ value, field, onCommit, onCancel }: CellEditorProps) {
  const opts = field.options ?? [];
  const commit = (next: CellValue) => {
    onCommit(next);
  };
  return (
    <Popover open onClose={onCancel} width={220} className="p-1">
      <div className="max-h-64 overflow-y-auto">
        {opts.map((o) => (
          <button
            key={o.id}
            type="button"
            className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left text-gx-13 hover:bg-gx-bg"
            onClick={() => commit(o.id)}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: o.color }} />
            <span className="flex-1 truncate text-gx-text-primary">{o.name}</span>
            {value === o.id && <Icon name="check" size={13} className="text-gx-accent" />}
          </button>
        ))}
        {opts.length === 0 && <div className="px-2 py-2 text-gx-12 text-gx-text-hint">无选项</div>}
      </div>
      <div className="mt-1 border-t border-gx-separator pt-1">
        <button
          type="button"
          className="w-full rounded-gx-sm px-2 py-1.5 text-left text-gx-13 text-gx-text-tertiary hover:bg-gx-bg"
          onClick={() => commit(null)}
        >
          清除
        </button>
      </div>
    </Popover>
  );
}

// ============ 多选 ============
function MultiSelectEditor({ value, field, onCommit, onCancel }: CellEditorProps) {
  const opts = field.options ?? [];
  const initial = useMemo(() => {
    if (!Array.isArray(value)) return new Set<string>();
    return new Set(value.map((v) => (typeof v === "string" ? v : String(v))));
  }, [value]);
  const [draft, setDraft] = useState<Set<string>>(initial);

  const toggle = (id: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 点空白提交
  const commit = () => onCommit(Array.from(draft));

  return (
    <Popover open onClose={commit} width={240} className="p-1">
      <div className="max-h-64 overflow-y-auto">
        {opts.map((o) => (
          <button
            key={o.id}
            type="button"
            className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left text-gx-13 hover:bg-gx-bg"
            onClick={() => toggle(o.id)}
          >
            <span
              className={clsx(
                "inline-flex h-4 w-4 items-center justify-center rounded border",
                draft.has(o.id) ? "border-gx-accent bg-gx-accent text-white" : "border-gx-border",
              )}
            >
              {draft.has(o.id) && <Icon name="check" size={12} />}
            </span>
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: o.color }} />
            <span className="flex-1 truncate text-gx-text-primary">{o.name}</span>
          </button>
        ))}
        {opts.length === 0 && <div className="px-2 py-2 text-gx-12 text-gx-text-hint">无选项</div>}
      </div>
      <div className="mt-1 border-t border-gx-separator pt-1">
        <button
          type="button"
          className="w-full rounded-gx-sm px-2 py-1.5 text-left text-gx-13 text-gx-text-tertiary hover:bg-gx-bg"
          onClick={() => {
            setDraft(new Set());
            onCommit([]);
          }}
        >
          清除
        </button>
      </div>
    </Popover>
  );
}

// ============ 日期 / 日期时间 ============
function DateEditor({ value, field, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  // 把值转成 input 需要的 yyyy-MM-dd 或 yyyy-MM-ddTHH:mm
  const toInput = (v: CellValue): string => {
    if (typeof v !== "string" || !v) return "";
    if (field.type === "date") return v.slice(0, 10);
    // datetime-local 需要 yyyy-MM-ddThh:mm
    return v.slice(0, 16);
  };
  const [draft, setDraft] = useState(toInput(value));

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <input
      ref={ref}
      type={field.type === "date" ? "date" : "datetime-local"}
      value={draft}
      className="h-8 w-full rounded-gx-lg border border-gx-accent bg-gx-surface px-2 text-gx-13 text-gx-text-primary focus:outline-none"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft || null, "down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          onCommit(draft || null, "right");
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(draft || null)}
    />
  );
}

// ============ 评分 ============
function RatingEditor({ value, onCommit, onCancel }: CellEditorProps) {
  const n = typeof value === "number" ? value : Number(value) || 0;
  return (
    <div className="flex h-full items-center gap-1 px-2" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          className="p-0.5"
          onClick={() => onCommit(i === n ? 0 : i)}
        >
          <Icon
            name="star"
            size={18}
            className={i <= n ? "text-gx-warning" : "text-gx-text-hint"}
            fill={i <= n ? "currentColor" : "none"}
          />
        </button>
      ))}
    </div>
  );
}

// ============ 关联：从关联表选记录 ============
function LinksEditor({ value, field, recordFields, onCommit, onCancel }: CellEditorProps) {
  const relatedTableId = field.relatedTableId;

  // 已选项（来自当前值）：即便不在当前搜索结果里也必须能回显/取消，不依赖候选页是否包含它。
  const initial = useMemo(() => {
    if (!Array.isArray(value)) return new Map<string, LinkRefDTO>();
    const m = new Map<string, LinkRefDTO>();
    (value as LinkRefDTO[]).forEach((l) => m.set(l.recordId, l));
    return m;
  }, [value]);
  const [draft, setDraft] = useState<Map<string, LinkRefDTO>>(initial);
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterFieldId, setFilterFieldId] = useState<string | null>(null);
  const [filterOp, setFilterOp] = useState<"contains" | "eq" | "gt" | "lt">("contains");
  const [filterValue, setFilterValue] = useState("");

  // 服务端限量 + 关键字搜索（hook 内部 250ms 防抖）：limit 50，绝不一次拉全表。
  const candidates = useLinkCandidates({ tableId: relatedTableId ?? null, search: query });
  const relFields = candidates.fields;
  const titleField = relFields[0];

  // 先应用 field.recordFilter（FieldEditorSheet 配的「关联筛选条件」持久化的子集过滤），
  // 再叠加临时 filterFieldId/Op/Value；都在当前候选页（≤50 条）之上做客户端收窄。
  const recordFilter = field.recordFilter ?? null;
  const selfVals = recordFields ?? {};
  const baseRecords = useMemo(() => {
    const records = candidates.records;
    if (!recordFilter) return records;
    return records.filter((r) =>
      evalFilter(
        recordFilter,
        (fid) => r.fields[fid] as never,
        (selfFid) => selfVals[selfFid] as never,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.records, recordFilter, recordFields]);

  const toggle = (recId: string, title: string) => {
    setDraft((prev) => {
      const next = new Map(prev);
      if (next.has(recId)) next.delete(recId);
      else next.set(recId, { tableId: (relatedTableId ?? "") as TableIdT, recordId: recId as RecordIdT, title });
      return next;
    });
  };
  const removeSelected = (recId: string) => {
    setDraft((prev) => {
      const next = new Map(prev);
      next.delete(recId);
      return next;
    });
  };
  const commit = () => onCommit(Array.from(draft.values()));

  // 关键字由服务端 search 处理；这里只叠加临时的「任意字段」过滤。
  const filtered = baseRecords.filter((r) => {
    if (filterFieldId && filterValue.trim()) {
      const v = String(r.fields[filterFieldId] ?? "");
      if (filterOp === "contains") { if (!v.toLowerCase().includes(filterValue.toLowerCase())) return false; }
      if (filterOp === "eq") { if (v !== filterValue) return false; }
      if (filterOp === "gt") { if (!(Number(v) > Number(filterValue))) return false; }
      if (filterOp === "lt") { if (!(Number(v) < Number(filterValue))) return false; }
    }
    return true;
  });

  // 候选页中已存在的记录 id，用于把「已选但不在候选里」的项单独置顶回显。
  const candidateIds = useMemo<Set<string>>(() => new Set(candidates.records.map((r) => r.id)), [candidates.records]);
  const selected = Array.from(draft.entries());
  const selectedNotInCandidates = selected.filter(([id]) => !candidateIds.has(id));

  return (
    <Popover open onClose={commit} width={320} className="p-2">
      <div className="flex gap-1">
        <Input
          autoFocus
          placeholder="搜索（按主字段）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          className="flex-1"
        />
        <button
          type="button"
          title="按任意字段筛选"
          onClick={() => setFilterOpen((v) => !v)}
          className={clsx(
            "flex h-8 items-center justify-center rounded-gx-sm border px-2 text-gx-12 transition-colors",
            filterOpen || filterFieldId
              ? "border-gx-accent bg-gx-accent-bg text-gx-accent"
              : "border-gx-border bg-gx-surface text-gx-text-secondary hover:bg-gx-bg",
          )}
        >
          <Icon name="filter" size={12} />
        </button>
      </div>
      {recordFilter && (
        <div className="mt-1.5 flex items-center gap-1 rounded-gx-sm bg-gx-accent-bg px-2 py-1 text-gx-11 text-gx-accent">
          <Icon name="filter" size={11} />
          <span>已应用字段默认筛选条件</span>
        </div>
      )}
      {filterOpen && (
        <div className="mt-2 space-y-1 rounded-gx-sm border border-gx-border bg-gx-bg p-2 text-gx-12">
          <div className="flex gap-1">
            <select value={filterFieldId ?? ""} onChange={(e) => setFilterFieldId(e.target.value || null)} className="flex-1 rounded-gx-sm border border-gx-border bg-gx-surface px-1 py-0.5">
              <option value="">选字段</option>
              {relFields.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
            </select>
            <select value={filterOp} onChange={(e) => setFilterOp(e.target.value as "contains" | "eq" | "gt" | "lt")} className="w-20 rounded-gx-sm border border-gx-border bg-gx-surface px-1 py-0.5">
              <option value="contains">包含</option>
              <option value="eq">等于</option>
              <option value="gt">&gt;</option>
              <option value="lt">&lt;</option>
            </select>
            <Input placeholder="值" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} className="w-24" />
            {filterFieldId && (
              <button type="button" onClick={() => { setFilterFieldId(null); setFilterValue(""); }} aria-label="清除筛选" title="清除筛选" className="px-1 text-gx-text-tertiary hover:text-gx-danger"><Icon name="close" size={12} /></button>
            )}
          </div>
        </div>
      )}
      {selected.length > 0 && (
        <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto rounded-gx-sm border border-gx-border bg-gx-bg p-1.5">
          {selected.map(([id, ref]) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-gx-sm bg-gx-accent-bg px-2 py-0.5 text-gx-11 text-gx-accent">
              {ref.title}
              <button type="button" onClick={() => removeSelected(id)} aria-label={`移除 ${ref.title}`} title={`移除 ${ref.title}`} className="hover:text-gx-danger"><Icon name="close" size={11} /></button>
            </span>
          ))}
        </div>
      )}
      {/* 候选满页：可能还有更多未列出，明确提示输入关键字，绝不假装已列全。 */}
      {candidates.needNarrow && (
        <div className="mt-2 flex items-start gap-1 rounded-gx-sm bg-gx-warning-bg px-2 py-1 text-gx-11 text-gx-warning">
          <Icon name="alertCircle" size={12} className="mt-0.5 shrink-0" />
          <span>{LINK_NARROW_TEXT}</span>
        </div>
      )}
      <div className="mt-2 max-h-48 overflow-y-auto">
        {candidates.isLoading ? (
          <div className="flex items-center justify-center gap-2 px-2 py-3 text-gx-12 text-gx-text-hint">
            <Spinner size={14} />
            <span>加载中…</span>
          </div>
        ) : filtered.length === 0 && selectedNotInCandidates.length === 0 ? (
          <div className="px-2 py-2 text-gx-12 text-gx-text-hint">无匹配记录</div>
        ) : (
          <>
            {/* 已选但不在当前候选页：置顶回显，标题沿用已存 LinkRef.title。 */}
            {selectedNotInCandidates.map(([id, ref]) => (
              <button key={`sel-${id}`} type="button" onClick={() => toggle(id, ref.title)} className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left text-gx-13 hover:bg-gx-bg">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded border border-gx-accent bg-gx-accent text-white">
                  <Icon name="check" size={12} />
                </span>
                <span className="flex-1 truncate text-gx-text-primary">{ref.title || "(空)"}</span>
              </button>
            ))}
            {filtered.map((r) => {
              const title = titleField ? formatCell(r.fields[titleField.id], titleField) : r.id;
              const checked = draft.has(r.id);
              return (
                <button key={r.id} type="button" onClick={() => toggle(r.id, title)} className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left text-gx-13 hover:bg-gx-bg">
                  <span className={clsx("inline-flex h-4 w-4 items-center justify-center rounded border", checked ? "border-gx-accent bg-gx-accent text-white" : "border-gx-border")}>
                    {checked && <Icon name="check" size={12} />}
                  </span>
                  <span className="flex-1 truncate text-gx-text-primary">{title || "(空)"}</span>
                </button>
              );
            })}
          </>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-gx-separator pt-1.5">
        <span className="text-gx-11 text-gx-text-hint">已选 {selected.length}</span>
        <div className="flex gap-1">
          <button type="button" onClick={onCancel} className="rounded-gx-sm px-2 py-0.5 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg">取消</button>
          <button type="button" onClick={commit} className="rounded-gx-sm bg-gx-accent px-2 py-0.5 text-gx-12 text-white hover:brightness-95">确认</button>
        </div>
      </div>
    </Popover>
  );
}

// ============ 附件：服务端上传（抽屉/表单/网格共用同一个上传器）============
//
// 旧实现是「本地读成 base64 塞进记录 JSON」：单文件 ≤2MB、大行拖垮 hydrate/导出
// （审计 U-3）。现在改走 POST /api/attachments，上限提到 20MB，并支持在线预览。
// 存量 dataURL 值**照旧渲染**——上传器只负责不再新增 dataURL，不改写历史数据。
function AttachmentEditor({ value, field, onCommit, onCancel }: CellEditorProps) {
  return (
    <div className="absolute inset-0 z-30 m-1 rounded-gx-lg border border-gx-accent bg-gx-surface p-2 shadow-lg">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-gx-12 font-medium text-gx-text-secondary">附件</span>
        <button type="button" className="text-gx-12 text-gx-text-hint hover:text-gx-danger" onClick={onCancel}>
          关闭
        </button>
      </div>
      <AttachmentUploader value={value} onChange={(next) => onCommit(next)} fieldId={field.id} compact />
    </div>
  );
}

export default CellEditor;

// ============ 成员 ============
function MemberCellEditor({ value, onCommit, onCancel }: CellEditorProps) {
  const { members, isLoading } = useMemberRoster();
  return (
    <MemberSelect
      value={value}
      members={members}
      isLoading={isLoading}
      onCommit={(userId) => onCommit(userId, "none")}
      onCancel={onCancel}
    />
  );
}

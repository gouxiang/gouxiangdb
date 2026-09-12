// apps/web/src/features/search/SearchDialog.tsx
// 全局统一搜索对话框（Cmd/Ctrl+K）：一次输入同时检索
//   ① 所有可访问智能表格中的记录
//   ② 所有可访问知识库中的文档 / 画布（标题 + 正文）
// 结果分组展示、键盘上下导航、回车或点击直达对应页面。
// 颜色走 gx-* token；命中关键词用 <mark> 高亮。

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGlobalSearch } from "../../api/hooks";
import type { GlobalRecordHit, GlobalDocHit } from "../../api/client";
import { Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";

export interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
}

type AnyHit =
  | (GlobalRecordHit & { key: string })
  | (GlobalDocHit & { key: string });

/** 把关键词在文本中高亮为 <mark> */
function highlight(text: string, q: string) {
  if (!q || !text) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-gx-accent-bg text-gx-accent">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function SearchDialog({ open, onClose }: SearchDialogProps) {
  const navigate = useNavigate();
  const [raw, setRaw] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setRaw("");
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // debounce 280ms
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), 280);
    return () => clearTimeout(t);
  }, [raw]);

  const { data, isFetching } = useGlobalSearch(q);

  const records: (GlobalRecordHit & { key: string })[] = useMemo(
    () => (data?.records ?? []).map((r) => ({ ...r, key: `r-${r.recordId}` })),
    [data],
  );
  const docs: (GlobalDocHit & { key: string })[] = useMemo(
    () => (data?.docs ?? []).map((d) => ({ ...d, key: `d-${d.docId}` })),
    [data],
  );
  const flat = useMemo<AnyHit[]>(() => [...docs, ...records], [docs, records]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  // 键盘上下选择时，高亮项自动滚动跟随到可视区域内
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open, q]);

  function go(hit: AnyHit) {
    if (hit.type === "record") {
      navigate(`/base/${hit.baseId}/table/${hit.tableId}?record=${hit.recordId}`);
    } else if (hit.type === "doc") {
      navigate(`/kb/${hit.kbId}/doc/${hit.docId}`);
    } else {
      navigate(`/kb/${hit.kbId}/canvas/${hit.docId}`);
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[active];
      if (item) go(item);
    }
  }

  if (!open) return null;

  const total = records.length + docs.length;

  const renderDoc = (d: GlobalDocHit & { key: string }, i: number, offset: number) => (
    <button
      key={d.key}
      type="button"
      onMouseEnter={() => setActive(i + offset)}
      onClick={() => go(d)}
      className={[
        "flex w-full items-center gap-2.5 border-b border-gx-separator px-4 py-2.5 text-left",
        i + offset === active ? "bg-gx-accent-bg" : "hover:bg-gx-bg",
      ].join(" ")}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-md bg-gx-bg text-gx-text-secondary">
        <Icon name={d.type === "canvas" ? "canvas" : "doc"} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-gx-11 text-gx-text-tertiary">{d.kbName}</span>
          <span className="rounded bg-gx-bg px-1.5 text-gx-10 text-gx-text-hint">
            {d.type === "canvas" ? "画布" : "文档"}
          </span>
          <span className="truncate text-gx-13 font-medium text-gx-text-primary">
            {highlight(d.title || "（未命名）", q)}
          </span>
        </span>
        {d.snippet && (
          <span className="truncate text-gx-12 text-gx-text-secondary">{highlight(d.snippet, q)}</span>
        )}
      </span>
    </button>
  );

  const renderRec = (r: GlobalRecordHit & { key: string }, i: number, offset: number) => (
    <button
      key={r.key}
      type="button"
      data-idx={i + offset}
      onMouseEnter={() => setActive(i + offset)}
      onClick={() => go(r)}
      className={[
        "flex w-full items-center gap-2.5 border-b border-gx-separator px-4 py-2.5 text-left",
        i + offset === active ? "bg-gx-accent-bg" : "hover:bg-gx-bg",
      ].join(" ")}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-md bg-gx-bg text-gx-text-secondary">
        <Icon name="rowHeight" size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-gx-11 text-gx-text-tertiary">{r.baseName} / {r.tableName}</span>
          <span className="truncate text-gx-13 font-medium text-gx-text-primary">
            {highlight(r.title || "（无标题）", q)}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-gx-12 text-gx-text-secondary">
          <span className="shrink-0 text-gx-text-hint">{r.matchedField}</span>
          <span className="truncate">{highlight(r.snippet, q)}</span>
        </span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-6 pt-[12vh]">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div
        className="relative flex max-h-[72vh] w-full max-w-[600px] flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-gx-separator px-3 py-2.5">
          <Icon name="search" size={16} className="text-gx-text-tertiary" />
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="搜索表格记录、知识库文档与画布…"
            className="flex-1 bg-transparent text-gx-14 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
          />
          {isFetching && <Spinner size={14} />}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto">
          {!q && (
            <div className="px-4 py-10 text-center text-gx-13 text-gx-text-hint">
              输入关键词，跨智能表格与知识库全局搜索
            </div>
          )}

          {q && !isFetching && total === 0 && (
            <div className="px-4 py-10 text-center text-gx-13 text-gx-text-hint">
              没有找到匹配的记录或文档
            </div>
          )}

          {docs.length > 0 && (
            <>
              <div className="sticky top-0 bg-gx-surface/95 px-4 py-1.5 text-gx-11 font-medium text-gx-text-hint backdrop-blur">
                知识库（{docs.length}）
              </div>
              {docs.map((d, i) => renderDoc(d, i, 0))}
            </>
          )}

          {records.length > 0 && (
            <>
              <div className="sticky top-0 bg-gx-surface/95 px-4 py-1.5 text-gx-11 font-medium text-gx-text-hint backdrop-blur">
                智能表格记录（{records.length}）
              </div>
              {records.map((r, i) => renderRec(r, i, docs.length))}
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-gx-separator px-3 py-1.5 text-gx-11 text-gx-text-hint">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}

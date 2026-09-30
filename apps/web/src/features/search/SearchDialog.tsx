// apps/web/src/features/search/SearchDialog.tsx
// 全局统一搜索对话框（Cmd/Ctrl+K）：一次输入同时检索
//   ① 所有可访问智能表格中的记录
//   ② 所有可访问知识库中的文档 / 画布（标题 + 正文）
// M5：数据源走 useUnifiedSearch（优先 /api/v1/search，flag off 自动回退旧 /api/search），
// 组件只消费归一后的 UnifiedHit，不感知 v1/旧链分支；mode/degraded 只以中性状态条呈现。
// 结果分组展示、键盘上下导航、回车或点击直达对应页面；命中关键词用 <mark> 高亮。

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUnifiedSearch } from "./search-hooks";
import { hitHref, type UnifiedHit } from "./search-adapter";
import { SearchImageBar, MAX_SEARCH_IMAGES } from "./SearchImageBar";
import { EmptyState, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";

export interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
}

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
  const [images, setImages] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setRaw("");
      setQ("");
      setImages([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // debounce 280ms（仅文本）；图片变化立即生效，不被文本防抖拖住。
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), 280);
    return () => clearTimeout(t);
  }, [raw]);

  const { data, isFetching } = useUnifiedSearch(q, images);

  const hits: UnifiedHit[] = useMemo(() => data?.hits ?? [], [data]);
  // doc/canvas 在前、record 在后（与旧版分组顺序一致）
  const docs = useMemo(() => hits.filter((h) => h.type === "doc" || h.type === "canvas"), [hits]);
  const records = useMemo(() => hits.filter((h) => h.type === "record"), [hits]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  // 图片增删也复位高亮。
  useEffect(() => {
    setActive(0);
  }, [images]);

  function addImages(urls: string[]) {
    setImages((prev) => [...prev, ...urls].slice(0, MAX_SEARCH_IMAGES));
  }
  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  // 键盘上下选择时，高亮项自动滚动跟随到可视区域内
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open, q]);

  function go(hit: UnifiedHit) {
    navigate(hitHref(hit));
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = hits[active];
      if (item) go(item);
    }
  }

  if (!open) return null;

  const renderDoc = (h: UnifiedHit, i: number, offset: number) => (
    <button
      key={h.key}
      type="button"
      onMouseEnter={() => setActive(i + offset)}
      onClick={() => go(h)}
      className={[
        "flex w-full items-center gap-2.5 border-b border-gx-separator px-4 py-2.5 text-left",
        i + offset === active ? "bg-gx-accent-bg" : "hover:bg-gx-bg",
      ].join(" ")}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-lg bg-gx-bg text-gx-text-secondary">
        <Icon name={h.type === "canvas" ? "canvas" : "doc"} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-gx-11 text-gx-text-tertiary">{h.kbName}</span>
          <span className="rounded bg-gx-bg px-1.5 text-gx-10 text-gx-text-hint">
            {h.type === "canvas" ? "画布" : "文档"}
          </span>
          <span className="truncate text-gx-13 font-medium text-gx-text-primary">
            {highlight(h.title || "（未命名）", q)}
          </span>
        </span>
        {h.snippet && (
          <span className="truncate text-gx-12 text-gx-text-secondary">{highlight(h.snippet, q)}</span>
        )}
      </span>
    </button>
  );

  const renderRec = (h: UnifiedHit, i: number, offset: number) => (
    <button
      key={h.key}
      type="button"
      data-idx={i + offset}
      onMouseEnter={() => setActive(i + offset)}
      onClick={() => go(h)}
      className={[
        "flex w-full items-center gap-2.5 border-b border-gx-separator px-4 py-2.5 text-left",
        i + offset === active ? "bg-gx-accent-bg" : "hover:bg-gx-bg",
      ].join(" ")}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-lg bg-gx-bg text-gx-text-secondary">
        <Icon name="rowHeight" size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-gx-11 text-gx-text-tertiary">{h.baseName} / {h.tableName}</span>
          <span className="truncate text-gx-13 font-medium text-gx-text-primary">
            {highlight(h.title || "（无标题）", q)}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-gx-12 text-gx-text-secondary">
          {h.matchedField && <span className="shrink-0 text-gx-text-hint">{h.matchedField}</span>}
          <span className="truncate">{highlight(h.snippet, q)}</span>
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

        {/* 以图搜图图片条 */}
        <div className="border-b border-gx-separator px-3 py-2">
          <SearchImageBar images={images} onAdd={addImages} onRemove={removeImage} />
        </div>

        {/* M5 中性状态条：仅在 v1 返回截断/降级文案时出现，不暴露任何实现细节 */}
        {q && data?.notice && (
          <div className="border-b border-gx-separator bg-gx-warning-bg px-4 py-1.5 text-gx-11 text-gx-text-secondary">
            {data.notice}
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto">
          {!q && images.length === 0 && (
            <div className="px-4 py-10 text-center text-gx-13 text-gx-text-hint">
              输入关键词，或上传图片以图搜图
            </div>
          )}

          {(q || images.length > 0) && !isFetching && hits.length === 0 && (
            images.length > 0 && !q
              ? <EmptyState kind="filtered" title="没有找到相似的记录或图片" description="换一张图片，或补充关键词再试。" />
              : <EmptyState kind="filtered" title="没有找到匹配的记录或文档" description="换个关键词试试，或改用更短的关键词。" />
          )}

          {docs.length > 0 && (
            <>
              <div className="sticky top-0 bg-gx-surface/95 px-4 py-1.5 text-gx-11 font-medium text-gx-text-hint backdrop-blur">
                知识库（{docs.length}）
              </div>
              {docs.map((h, i) => renderDoc(h, i, 0))}
            </>
          )}

          {records.length > 0 && (
            <>
              <div className="sticky top-0 bg-gx-surface/95 px-4 py-1.5 text-gx-11 font-medium text-gx-text-hint backdrop-blur">
                智能表格记录（{records.length}）
              </div>
              {records.map((h, i) => renderRec(h, i, docs.length))}
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

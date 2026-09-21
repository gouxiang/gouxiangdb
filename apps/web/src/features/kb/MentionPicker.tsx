// apps/web/src/features/kb/MentionPicker.tsx
// 「@」引用选择面板：成员 / 文档 / 画布 分组，可搜索，键盘 ↑↓ Enter Esc。
// 选中后通过 onPick(markdownSnippet) 回传要插入的 Markdown 片段：
//   成员 → @[u:id|名]；文档/画布 → [标题](/kb/:kbId/kind/id)；画布额外可选择"内嵌预览块"。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/icons";
import { useKbDocs } from "./kb-hooks";
// 成员候选改走组织通讯录：权限核心模型后 /kb/:kbId/members 已变成「哪些角色覆盖本库」的
// 只读台账，不再返回人员名单，@提及无法再按库取人。通讯录是唯一的人员名册来源，
// 门控是 view_directory——没有该动作的人拿到的是空列表，成员分组随之不渲染（fail-closed）。
import { useOrgMembers } from "../contacts/contacts-hooks";
import { DocKindIcon } from "./kb-ui";
import { userMention, docLink, canvasEmbedFence } from "./mentions";

export interface PickerPos {
  top: number;
  left: number;
}

export function MentionPicker({
  kbId,
  currentDocId,
  pos,
  onPick,
  onClose,
}: {
  kbId: string;
  /** 当前编辑文档/画布 id，picker 列表排除自身（不允许 @ 自己） */
  currentDocId?: string;
  pos: PickerPos;
  onPick: (snippet: string, isCanvasEmbed?: boolean) => void;
  onClose: () => void;
}) {
  // 只取在岗成员一页（100 人为服务端单页上限），本地按输入过滤——提及是随手选人，
  // 不值得为每次敲键打一次服务端；停用与待激活账号不进候选（@ 了也收不到）。
  const roster = useOrgMembers({ q: "", deptId: null, status: "ACTIVE" });
  const { data: docs } = useKbDocs(kbId, "all");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const memberItems = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (roster.isError ? [] : roster.items)
      .filter((m) => !kw || (m.displayName ?? m.email ?? "").toLowerCase().includes(kw))
      .slice(0, 6)
      .map((m) => ({
        key: `u-${m.id}`,
        type: "user" as const,
        title: m.displayName || m.email || "成员",
        sub: m.email,
        id: m.id,
      }));
  }, [roster.items, roster.isError, q]);

  const docItems = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (docs ?? [])
      .filter((d) => !d.deletedAt)
      // 排除当前编辑的文档/画布自身——@自己无意义
      .filter((d) => d.id !== currentDocId)
      .filter((d) => !kw || d.title.toLowerCase().includes(kw))
      .slice(0, 8)
      .map((d) => ({ key: `d-${d.id}`, type: "doc" as const, title: d.title || "未命名", kind: d.kind, id: d.id }));
  }, [docs, q, currentDocId]);

  const flat = useMemo(() => [...memberItems, ...docItems], [memberItems, docItems]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 键盘上下移动时高亮项自动滚动到可视区（与斜杠菜单一致），列表再长也不丢焦点指示
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-mention-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(item: (typeof flat)[number], asEmbed = false) {
    if (item.type === "user") {
      onPick(userMention(item.id, item.title));
    } else if (item.kind === "canvas" && asEmbed) {
      onPick(canvasEmbedFence(item.id), true);
    } else {
      onPick(docLink(kbId, item.kind, item.id, item.title));
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // flat 为「成员 + 文档」的可见扁平列表，逐项移动与鼠标 hover 的 active 索引完全一致
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = flat[active];
      if (it) pick(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="fixed z-50 w-72 overflow-hidden rounded-gx-lg border border-gx-separator bg-gx-surface shadow-2xl"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="border-b border-gx-separator p-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder="提及成员，或引用文档/画布…"
          className="w-full rounded-gx-sm bg-gx-bg px-2 py-1.5 text-gx-13 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
        />
      </div>
      <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {memberItems.length > 0 && (
          <div className="px-2 pb-0.5 pt-1 text-gx-11 font-medium text-gx-text-hint">成员</div>
        )}
        {memberItems.map((m, i) => (
          <button
            key={m.key}
            type="button"
            data-mention-idx={i}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(m)}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${active === i ? "bg-gx-accent-bg" : ""}`}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gx-accent text-gx-11 font-medium text-white">
              {(m.title || "?").charAt(0)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-gx-13 text-gx-text-primary">{m.title}</span>
              {m.sub && <span className="block truncate text-gx-11 text-gx-text-hint">{m.sub}</span>}
            </span>
          </button>
        ))}

        {docItems.length > 0 && (
          <div className="px-2 pb-0.5 pt-2 text-gx-11 font-medium text-gx-text-hint">文档与画布</div>
        )}
        {docItems.map((d, di) => {
          const idx = memberItems.length + di;
          return (
            <div
              key={d.key}
              data-mention-idx={idx}
              onMouseEnter={() => setActive(idx)}
              className={`group flex w-full items-center gap-2 px-2.5 py-1.5 ${active === idx ? "bg-gx-accent-bg" : ""}`}
            >
              <button type="button" onClick={() => pick(d)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <DocKindIcon kind={d.kind} size={14} />
                <span className="truncate text-gx-13 text-gx-text-primary">{d.title}</span>
              </button>
              {d.kind === "canvas" && (
                <button
                  type="button"
                  title="内嵌为画布预览块"
                  onClick={() => pick(d, true)}
                  className="shrink-0 rounded-gx-sm px-1.5 py-0.5 text-gx-11 text-gx-accent opacity-0 hover:bg-gx-surface group-hover:opacity-100"
                >
                  <Icon name="expand" size={13} />
                  内嵌
                </button>
              )}
            </div>
          );
        })}

        {flat.length === 0 && (
          <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">无匹配结果</div>
        )}
      </div>
    </div>
  );
}

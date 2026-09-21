// apps/web/src/features/kb/MentionPicker.tsx
// 「@」引用选择面板：成员 / 文档 / 画布 / 数据表 分组，可搜索，键盘 ↑↓ Enter Esc。
// 选中后通过 onPick(markdownSnippet, embed) 回传要插入的 Markdown 片段：
//   成员 → @[u:id|名]
//   文档/画布 → [标题](/kb/:kbId/kind/id)；画布额外可选「内嵌预览块」
//   数据表 → 默认插内嵌预览 ```table-embed；「链接」按钮插 [标题](/base/:baseId/table/:tableId)
//
// 候选项一律来自 GET /api/linkable —— **后端已按库权限过滤**，看不见的对象不会出现在这里，
// 前端不做任何可见性判断。（成员仍走组织通讯录：/kb/:kbId/members 已变成只读权限台账。）

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/icons";
// 成员候选改走组织通讯录：权限核心模型后 /kb/:kbId/members 已变成「哪些角色覆盖本库」的
// 只读台账，不再返回人员名单，@提及无法再按库取人。通讯录是唯一的人员名册来源，
// 门控是 view_directory——没有该动作的人拿到的是空列表，成员分组随之不渲染（fail-closed）。
import { useOrgMembers } from "../contacts/contacts-hooks";
import { useLinkable } from "./canvas/linkable-hooks";
import { DocKindIcon } from "./kb-ui";
import { userMention, docLink, canvasEmbedFence, tableEmbedFence } from "./mentions";
import type { LinkableItem } from "../../api/client";

export interface PickerPos {
  top: number;
  left: number;
}

/** 插入片段是不是「围栏内嵌块」（决定编辑器要不要额外补一个换行/结构化块）。 */
export type MentionEmbedKind = "canvas" | "table";

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
  onPick: (snippet: string, embed?: MentionEmbedKind) => void;
  onClose: () => void;
}) {
  // 只取在岗成员一页（100 人为服务端单页上限），本地按输入过滤——提及是随手选人，
  // 不值得为每次敲键打一次服务端；停用与待激活账号不进候选（@ 了也收不到）。
  const roster = useOrgMembers({ q: "", deptId: null, status: "ACTIVE" });
  // 可关联对象一次取回（后端已按权限过滤），本地过滤同成员候选，避免每次敲键打请求。
  const { data: linkable } = useLinkable({ types: ["doc", "canvas", "table"], limit: 50 });
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const kw = q.trim().toLowerCase();

  const memberItems = useMemo(() => {
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
  }, [roster.items, roster.isError, kw]);

  const linkableItems = useMemo(
    () => (linkable?.items ?? []).filter((it) => it.id !== currentDocId),
    [linkable?.items, currentDocId],
  );

  const docItems = useMemo(
    () =>
      linkableItems
        .filter((it) => it.type === "doc" || it.type === "canvas")
        .filter((it) => !kw || it.title.toLowerCase().includes(kw)),
    [linkableItems, kw],
  );

  const tableItems = useMemo(
    () => linkableItems.filter((it) => it.type === "table").filter((it) => !kw || it.title.toLowerCase().includes(kw)),
    [linkableItems, kw],
  );

  const flat = useMemo(
    () => [
      ...memberItems.map((m) => ({ group: "user" as const, m })),
      ...docItems.map((d) => ({ group: "doc" as const, d })),
      ...tableItems.map((t) => ({ group: "table" as const, t })),
    ],
    [memberItems, docItems, tableItems],
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  // 键盘上下移动时高亮项自动滚动到可视区（与斜杠菜单一致），列表再长也不丢焦点指示
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-mention-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pickDoc(d: LinkableItem, asEmbed = false) {
    const kind = d.type === "canvas" ? "canvas" : "doc";
    if (kind === "canvas" && asEmbed) onPick(canvasEmbedFence(d.id), "canvas");
    else onPick(docLink(kbId, kind, d.id, d.title || "未命名"));
    onClose();
  }

  /** 数据表：默认插内嵌预览（可读原表视图），「链接」按钮插普通站内链接。 */
  function pickTable(t: LinkableItem, asEmbed = true) {
    if (asEmbed) onPick(tableEmbedFence(t.id, null), "table");
    else if (t.libraryId) onPick(`[${t.title || "数据表"}](/base/${t.libraryId}/table/${t.id})`);
    else onPick(tableEmbedFence(t.id, null), "table");
    onClose();
  }

  function pickAt(idx: number) {
    const it = flat[idx];
    if (!it) return;
    if (it.group === "user") {
      onPick(userMention(it.m.id, it.m.title));
      onClose();
    } else if (it.group === "doc") pickDoc(it.d);
    else pickTable(it.t);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickAt(active);
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
          placeholder="提及成员，或引用文档/画布/数据表…"
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
            onClick={() => pickAt(i)}
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
              key={`d-${d.id}`}
              data-mention-idx={idx}
              onMouseEnter={() => setActive(idx)}
              className={`group flex w-full items-center gap-2 px-2.5 py-1.5 ${active === idx ? "bg-gx-accent-bg" : ""}`}
            >
              <button type="button" onClick={() => pickDoc(d)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <DocKindIcon kind={d.type === "canvas" ? "canvas" : "doc"} size={14} icon={d.icon} iconColor={d.iconColor} />
                <span className="truncate text-gx-13 text-gx-text-primary">{d.title || "未命名"}</span>
              </button>
              {d.type === "canvas" && (
                <button
                  type="button"
                  title="内嵌为画布预览块"
                  onClick={() => pickDoc(d, true)}
                  className="shrink-0 rounded-gx-sm px-1.5 py-0.5 text-gx-11 text-gx-accent opacity-0 hover:bg-gx-surface group-hover:opacity-100"
                >
                  <Icon name="expand" size={13} />
                  内嵌
                </button>
              )}
            </div>
          );
        })}

        {tableItems.length > 0 && (
          <div className="px-2 pb-0.5 pt-2 text-gx-11 font-medium text-gx-text-hint">数据表</div>
        )}
        {tableItems.map((t, ti) => {
          const idx = memberItems.length + docItems.length + ti;
          return (
            <div
              key={`t-${t.id}`}
              data-mention-idx={idx}
              onMouseEnter={() => setActive(idx)}
              className={`group flex w-full items-center gap-2 px-2.5 py-1.5 ${active === idx ? "bg-gx-accent-bg" : ""}`}
            >
              <button type="button" onClick={() => pickTable(t)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <DocKindIcon kind="table" size={14} icon={t.icon} iconColor={t.iconColor} />
                <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary">{t.title || "未命名"}</span>
                {t.libraryName && <span className="shrink-0 truncate text-gx-11 text-gx-text-hint">{t.libraryName}</span>}
              </button>
              <button
                type="button"
                title="插入为普通链接而不是内嵌预览"
                onClick={() => pickTable(t, false)}
                className="shrink-0 rounded-gx-sm px-1.5 py-0.5 text-gx-11 text-gx-accent opacity-0 hover:bg-gx-surface group-hover:opacity-100"
              >
                <Icon name="link" size={13} />
                链接
              </button>
            </div>
          );
        })}

        {flat.length === 0 && (
          <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">无匹配结果</div>
        )}
        {linkable?.truncated && (
          <div className="px-2.5 pb-1 pt-2 text-gx-11 text-gx-text-hint">
            结果已截断，试试输入关键词缩小范围。
          </div>
        )}
      </div>
    </div>
  );
}

// apps/web/src/features/kb/PublicDocView.tsx
// 公开分享页的「主内容区」：顶栏（标题 / 档位徽标 / 保存 / 打开）+ 正文或画布。
// 从 PublicSharePage 抽出并改成「props 进、确定性渲染」——便于在无 jsdom 的 node 环境
// 用 renderToStaticMarkup 直接验 canEdit 真假两条路径的渲染（fail-closed 也在这测）。
//
// 编辑权限一律来自 doc.canEdit（fail-closed：非 true 即只读）；保存走乐观锁 baseUpdatedAt。

import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { MarkdownEditor } from "./MarkdownEditor";
import { GxCanvas } from "./canvas/GxCanvas";
import { DocKindIcon } from "./kb-ui";
import { DocOutline } from "./DocOutline";
import { usePublicDocEditing } from "./usePublicDocEditing";

export interface RemoteDoc {
  id: string;
  content: string;
  title: string;
  kind: string;
  /** 本文档能否编辑（fail-closed：非 true 一律按不可编辑） */
  canEdit: boolean;
  /** 乐观锁基线：保存时回传 */
  updatedAt?: string;
}

export function PublicDocView({
  doc,
  token,
  embedCanEdit,
}: {
  doc: RemoteDoc;
  token: string | undefined;
  /** 宿主分享档位：内嵌数据表预览按它决定只读/可编辑（与正文 canEdit 独立） */
  embedCanEdit: boolean;
}) {
  const navigate = useNavigate();
  const canEdit = doc.canEdit === true;
  const editing = usePublicDocEditing({
    token,
    docId: doc.id,
    kind: doc.kind,
    content: doc.content,
    baseUpdatedAt: doc.updatedAt,
    canEdit,
  });

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-gx-separator bg-gx-surface px-4 py-2.5">
        <DocKindIcon kind={doc.kind as "doc" | "canvas"} />
        <span className="min-w-0 flex-1 truncate text-gx-14 font-semibold text-gx-text-primary">{doc.title}</span>
        {/* 档位徽标：可编辑 → 「可编辑」，只读 → 「仅可见」 */}
        <span className="inline-flex items-center gap-1 rounded-gx-sm bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-tertiary">
          <Icon name={canEdit ? "edit" : "eye"} size={12} />
          {canEdit ? "可编辑" : "仅可见"}
        </span>
        {canEdit && (
          <button
            type="button"
            disabled={editing.saving}
            onClick={() => void editing.saveNow()}
            className="inline-flex items-center gap-1 rounded-gx-lg bg-gx-accent px-2.5 py-1 text-gx-12 font-medium text-white hover:brightness-95 disabled:opacity-60"
          >
            <Icon name="save" size={12} />
            {editing.saving ? "保存中…" : "保存"}
          </button>
        )}
        <button
          type="button"
          onClick={() => navigate("/login")}
          className="rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 py-1 text-gx-12 text-gx-text-secondary hover:bg-gx-bg"
        >
          在构想工作台中打开
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {doc.kind === "canvas" ? (
          <div className="relative h-full">
            <GxCanvas
              key={`${doc.id}#${editing.revision}`}
              docId={doc.id}
              content={editing.content}
              canEdit={canEdit}
              publicToken={token}
              embedCanEdit={embedCanEdit}
              onContentChange={editing.setLocalContent}
              onSave={() => void editing.saveNow()}
            />
          </div>
        ) : (
          <MarkdownDocArea
            docId={doc.id}
            revision={editing.revision}
            content={editing.content}
            canEdit={canEdit}
            token={token}
            embedCanEdit={embedCanEdit}
            onLocalContent={editing.setLocalContent}
            onSave={() => void editing.saveNow()}
          />
        )}
      </div>
    </main>
  );
}

// 正文（Markdown）区：滚动容器 + 右侧大纲。抽出以避免 PublicDocView 过长。
function MarkdownDocArea({
  docId,
  revision,
  content,
  canEdit,
  token,
  embedCanEdit,
  onLocalContent,
  onSave,
}: {
  docId: string;
  revision: number;
  content: string;
  canEdit: boolean;
  token: string | undefined;
  embedCanEdit: boolean;
  onLocalContent: (md: string) => void;
  onSave: () => void;
}) {
  const docAreaRef = useRef<HTMLDivElement>(null);
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-gx-surface" ref={docAreaRef}>
      <div className="min-h-0 flex-1 overflow-y-auto" data-outline-scroll>
        <div className="mx-auto max-w-3xl px-6 py-6">
          <MarkdownEditor
            key={`${docId}#${revision}`}
            initialMarkdown={content}
            readOnly={!canEdit}
            docId={docId}
            publicToken={token}
            embedCanEdit={embedCanEdit}
            onChange={onLocalContent}
            onSave={onSave}
          />
        </div>
      </div>
      <DocOutline rootRef={docAreaRef} />
    </div>
  );
}

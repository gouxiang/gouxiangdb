// apps/web/src/features/kb/PublicDocShare.tsx
// 公开分享页的「文档 / 画布」分支（历史 kb_doc 族，后端 kind 字面量为 "doc" 或缺省）。
// 负责「分享根 + 选中子文档 + 拉内容」，渲染交给 PublicDocView（保留可编辑能力，不回归）。
//
// 从 PublicSharePage 抽出：三类分享（doc/table/base）按 kind 分发后，文档族的既有逻辑
// （级联文档树、子文档拉取、正文可编辑判定）原样落在本组件。
//
// 正文是否可编辑由**读取接口的真实 canEdit** 决定（fail-closed：缺字段/出错一律只读）：
//   - 分享根看 GET /api/public/s/:token 的 canEdit；
//   - 子树内某篇看 GET /api/public/s/:token/doc/:docId 的 canEdit。
// 可编辑档位且分享人此刻仍有内容编辑权时 canEdit=true；保存走乐观锁（baseUpdatedAt）。

import { useEffect, useState } from "react";
import { Spinner, toast } from "../../components/ui";
import { PublicApi } from "../../api/client";
import type { PublicDocShareDTO } from "../../api/client";
import { PublicShareTree } from "./PublicShareTree";
import { PublicDocView, type RemoteDoc } from "./PublicDocView";

export function PublicDocShare({
  token,
  data,
  routeDocId,
}: {
  token: string | undefined;
  data: PublicDocShareDTO;
  routeDocId?: string;
}) {
  const [activeDocId, setActiveDocId] = useState<string | undefined>(undefined);
  // 根文档直接用分享根数据同步初始化（避免首帧空闪；SSR 也能确定性渲染）。
  // 子文档（routeDocId/activeDocId 指向非根）由下方 effect 拉取后覆盖。
  const [remoteDoc, setRemoteDoc] = useState<RemoteDoc | null>(() =>
    data
      ? {
          id: data.doc.id,
          content: data.doc.content,
          title: data.doc.title,
          kind: data.doc.kind,
          canEdit: data.canEdit === true,
          updatedAt: data.doc.updatedAt,
        }
      : null,
  );
  const [docLoading, setDocLoading] = useState(false);

  // 当前展示的文档：路由/树选中的子文档，否则根文档
  const effectiveDocId = routeDocId ?? activeDocId ?? data.doc.id;

  // 分享根切换（换 token）时重新落到根文档
  useEffect(() => {
    if (data) {
      setRemoteDoc({
        id: data.doc.id,
        content: data.doc.content,
        title: data.doc.title,
        kind: data.doc.kind,
        canEdit: data.canEdit === true,
        updatedAt: data.doc.updatedAt,
      });
      setActiveDocId(undefined);
    }
  }, [data.rootToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换子文档时拉取内容（每篇各自带自己的 canEdit 与 updatedAt 基线）
  useEffect(() => {
    if (!token || !effectiveDocId || !data) return;
    if (effectiveDocId === data.doc.id) {
      setRemoteDoc({
        id: data.doc.id,
        content: data.doc.content,
        title: data.doc.title,
        kind: data.doc.kind,
        canEdit: data.canEdit === true,
        updatedAt: data.doc.updatedAt,
      });
      return;
    }
    let alive = true;
    setDocLoading(true);
    PublicApi.getDoc(token, effectiveDocId)
      .then((r) => {
        if (alive)
          setRemoteDoc({
            id: r.doc.id,
            content: r.doc.content,
            title: r.doc.title,
            kind: r.doc.kind,
            canEdit: r.canEdit === true,
            updatedAt: r.doc.updatedAt,
          });
      })
      .catch((e) => {
        if (alive) {
          // fail-closed：内容没拿到就清空并按只读渲染，绝不沿用上一篇的编辑权
          setRemoteDoc(null);
          toast(e instanceof Error ? e.message : "无法加载该内容", "error");
        }
      })
      .finally(() => alive && setDocLoading(false));
    return () => {
      alive = false;
    };
  }, [effectiveDocId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const showTree = data.includeChildren && data.tree.length > 0;
  // 宿主分享档位：决定文档/画布里【嵌入的数据表预览】能不能写。
  const embedCanEdit = data.mode === "edit";

  return (
    <div className="flex h-screen bg-gx-bg">
      {/* 左侧分享文档树 */}
      {showTree && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-gx-separator bg-gx-surface">
          <div className="border-b border-gx-separator px-3 py-2.5 text-gx-12 font-medium text-gx-text-secondary">分享内容</div>
          <PublicShareTree items={data.tree} rootId={data.doc.id} activeId={effectiveDocId} onOpen={setActiveDocId} />
        </aside>
      )}

      {docLoading ? (
        <main className="flex min-w-0 flex-1 items-center justify-center">
          <Spinner size={20} />
        </main>
      ) : remoteDoc ? (
        <PublicDocView key={remoteDoc.id} doc={remoteDoc} token={token} embedCanEdit={embedCanEdit} />
      ) : (
        <main className="flex min-w-0 flex-1 items-center justify-center text-gx-13 text-gx-text-tertiary">
          无法加载该内容
        </main>
      )}
    </div>
  );
}

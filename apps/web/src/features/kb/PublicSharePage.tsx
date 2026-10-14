// apps/web/src/features/kb/PublicSharePage.tsx
// 公开分享页（/s/:token）外壳：匿名可访问，无需登录。负责「加载分享 + 选中文档 + 拉内容」，
// 渲染交给 PublicDocView（可被单测直接渲染）。
//
// 正文是否可编辑由**读取接口的真实 canEdit** 决定（fail-closed：缺字段/出错一律按只读）：
//   - 分享根看 GET /api/public/s/:token 的 canEdit；
//   - 子树内某篇看 GET /api/public/s/:token/doc/:docId 的 canEdit；
//     引用闭包内的文档（/ref/）仍恒只读，不属于本次分享子树。
// 可编辑档位且分享人此刻仍有内容编辑权时 canEdit=true；分享人被降权后后端每次访问现算，
// 链接自动回落只读。保存走乐观锁（baseUpdatedAt）：冲突回 409 就地刷新为最新内容并提示重编。
// - 级联分享：左侧文档树，仅展示被分享根节点及其下级，支持展开/收起/点击切换

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Spinner, toast } from "../../components/ui";
import { PublicApi } from "../../api/client";
import { usePublicShare } from "./kb-hooks";
import { PublicShareTree } from "./PublicShareTree";
import { PublicDocView, type RemoteDoc } from "./PublicDocView";
import { useProductName } from "../branding/useBranding";

export default function PublicSharePage() {
  const { token, docId: routeDocId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = usePublicShare(token);
  // 匿名页同样在 QueryClientProvider 内，品牌探针公开可读
  const productName = useProductName();

  const [activeDocId, setActiveDocId] = useState<string | undefined>(undefined);
  const [remoteDoc, setRemoteDoc] = useState<RemoteDoc | null>(null);
  const [docLoading, setDocLoading] = useState(false);

  // 当前展示的文档：路由/树选中的子文档，否则根文档
  const effectiveDocId = routeDocId ?? activeDocId ?? data?.doc.id;

  // 根数据加载后初始化
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
  }, [data?.rootToken]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-gx-bg text-center">
        <Icon name="link" size={32} className="text-gx-text-hint" />
        <div className="text-gx-15 font-semibold text-gx-text-primary">分享链接已失效或被取消</div>
        <div className="text-gx-13 text-gx-text-tertiary">该链接可能已被分享者关闭，或内容已被删除。</div>
        <button
          type="button"
          onClick={() => navigate("/login")}
          className="mt-2 rounded-gx-lg bg-gx-accent px-4 py-2 text-gx-13 font-medium text-white hover:brightness-95"
        >
          返回{productName}
        </button>
      </div>
    );
  }

  const showTree = data.includeChildren && data.tree.length > 0;
  // 宿主分享档位：决定文档/画布里【嵌入的数据表预览】能不能写。
  // 与「正文能否写」是两件事：正文看 canEdit，嵌入表看 mode（后端按同一档位分别算）。
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

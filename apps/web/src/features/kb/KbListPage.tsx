// apps/web/src/features/kb/KbListPage.tsx
// /kb —— 全部知识库网格 + 新建入口。

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Input, Modal, Spinner, toast } from "../../components/ui";
import { resolveEntityIcon } from "../../components/EntityIconPicker";
import { useKbList, useCreateKb } from "./kb-hooks";
import { useCanCreateLibrary } from "../../api/hooks";
import { formatTime, roleLabel } from "./kb-ui";
import { AVATAR_PALETTE } from "@gx/design-tokens";

function dotColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export default function KbListPage() {
  const navigate = useNavigate();
  const { data: kbs, isLoading } = useKbList();
  const createKb = useCreateKb();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  // 权限门：无 create_library 的用户两个新建入口都不渲染（右上角按钮 + 列表末尾虚线卡片）。
  const canCreate = useCanCreateLibrary();

  async function create() {
    if (!name.trim() || createKb.isPending) return;
    try {
      const r = await createKb.mutateAsync({ name: name.trim(), iconColor: dotColor(name.trim()) });
      setName("");
      setShowNew(false);
      navigate(`/kb/${r.knowledgeBase.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建知识库失败", "error");
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-gx-bg">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-gx-18 font-semibold text-gx-text-primary">知识库</h1>
            <p className="mt-1 text-gx-12 text-gx-text-tertiary">文档与画布的团队知识空间，与数据表相互独立。</p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white hover:brightness-95"
            >
              <Icon name="plus" size={15} />
              新建知识库
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20"><Spinner size={22} /></div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(kbs ?? []).map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => navigate(`/kb/${k.id}`)}
                className="group flex items-start gap-3 rounded-gx-2xl border border-gx-hairline bg-gx-surface p-4 text-left shadow-gx-card transition-shadow hover:shadow-gx-md"
              >
                <span
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-gx-lg text-white"
                  style={{ backgroundColor: k.iconColor || dotColor(k.name) }}
                >
                  {/* 未自定义时仍是白「book」；自定义后按实体图标渲染（背景色逻辑不变） */}
                  <Icon name={resolveEntityIcon(k, { name: "book" }).name} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-gx-14 font-medium text-gx-text-primary">{k.name}</span>
                  <span className="mt-1 block text-gx-11 text-gx-text-hint">
                    {k.docCount ?? 0} 篇内容 · {roleLabel(k.role)}
                  </span>
                  {k.updatedAt && (
                    <span className="mt-0.5 block text-gx-11 text-gx-text-hint">更新于 {formatTime(k.updatedAt)}</span>
                  )}
                </span>
              </button>
            ))}

            {/* 新建卡片 */}
            {canCreate && (
              <button
                type="button"
                onClick={() => setShowNew(true)}
                className="flex items-center justify-center gap-2 rounded-gx-2xl border border-dashed border-gx-border-strong bg-gx-surface/50 p-4 text-gx-13 text-gx-text-tertiary hover:border-gx-accent hover:text-gx-accent"
              >
                <Icon name="plus" size={16} />
                新建知识库
              </button>
            )}
          </div>
        )}
      </div>

      {/* 弹窗随权限门一并收起：无权限时不存在任何可提交的建库表单 */}
      {canCreate && (
        <Modal
          open={showNew}
          title="新建知识库"
          onClose={() => setShowNew(false)}
          footer={
            <>
              <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setShowNew(false)}>
                取消
              </button>
              <button
                className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
                disabled={!name.trim() || createKb.isPending}
                onClick={create}
              >
                创建
              </button>
            </>
          }
        >
          <Input
            autoFocus
            placeholder="知识库名称，如：产品资料库"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
        </Modal>
      )}
    </div>
  );
}

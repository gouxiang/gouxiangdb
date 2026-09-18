// apps/web/src/features/kb/DocAclModal.tsx
// 单文档/画布独立权限弹窗：按邮箱授予 editor/commenter/viewer，列出并可撤销。
// 权限与知识库成员角色叠加，取较高者（后端 RANK 逻辑）。

import { useMemo, useState } from "react";
import { Icon } from "../../components/icons";
import { Input, Modal, Select, Spinner, toast } from "../../components/ui";
import type { KbDocDTO } from "../../api/client";
import { useDocAcl, useSetDocAcl } from "./kb-hooks";
import { roleLabel } from "./kb-ui";
import { useAuthzCapability } from "../authz/useAuthzCapability";
import { useNavNodeIndex } from "../workspace/nav-hooks";
import { DocPolicyView } from "../authz/DocPolicyView";

const ROLE_OPTIONS = [
  { value: "editor", label: "可编辑" },
  { value: "commenter", label: "可评论" },
  { value: "viewer", label: "仅查看" },
];

export function DocAclModal({ doc, onClose }: { doc: KbDocDTO; onClose: () => void }) {
  const { canManage } = useAuthzCapability();
  const { index } = useNavNodeIndex();
  // doc 节点 resourceType=doc、resourceId=kb_docs.id；门控开且能在 M3 树解析到节点时切企业同表视图。
  const navNode = useMemo(
    () => index.byResource.get(`doc:${doc.id}`) ?? null,
    [index.byResource, doc.id],
  );
  const useUnified = canManage && !!navNode;

  return (
    <Modal open title={`独立权限 · ${doc.title}`} onClose={onClose} width={520} footer={
      <button
        className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
        onClick={onClose}
      >
        完成
      </button>
    }>
      {useUnified && navNode ? (
        <DocPolicyView node={navNode} />
      ) : (
        <LegacyDocAcl doc={doc} />
      )}
    </Modal>
  );
}

/** 旧三档视图（门控关 / 未挂企业导航时保持原通道，生产默认形态）。 */
function LegacyDocAcl({ doc }: { doc: KbDocDTO }) {
  const { data: acls, isLoading } = useDocAcl(doc.id);
  const setAcl = useSetDocAcl(doc.id);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "commenter" | "viewer">("viewer");

  async function grant() {
    const e = email.trim();
    if (!e || setAcl.isPending) return;
    try {
      await setAcl.mutateAsync({ email: e, role });
      toast("已更新权限", "success");
      setEmail("");
    } catch (err) {
      toast(err instanceof Error ? err.message : "授权失败", "error");
    }
  }

  async function revoke(userId: string, userEmail: string) {
    try {
      await setAcl.mutateAsync({ email: userEmail, role: null });
      toast("已撤销独立权限", "success");
      void userId;
    } catch (err) {
      toast(err instanceof Error ? err.message : "撤销失败", "error");
    }
  }

  return (
    <>
      <p className="mb-3 text-gx-12 text-gx-text-tertiary">
        为此{doc.kind === "canvas" ? "画布" : "文档"}单独指定成员权限，独立权限与知识库角色叠加、取较高者。
      </p>

      <div className="mb-4 flex items-center gap-2">
        <Input
          placeholder="成员邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && grant()}
          className="flex-1"
        />
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
          options={ROLE_OPTIONS}
          className="h-8"
        />
        <button
          type="button"
          disabled={!email.trim() || setAcl.isPending}
          onClick={grant}
          className="inline-flex h-8 items-center gap-1 rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-40"
        >
          <Icon name="check" size={14} />
          授权
        </button>
      </div>

      <div className="overflow-hidden rounded-gx-lg border border-gx-border">
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner size={18} /></div>
        ) : (acls ?? []).length === 0 ? (
          <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">暂无独立授权成员</div>
        ) : (
          (acls ?? []).map((a) => (
            <div key={a.userId} className="flex items-center gap-2 border-b border-gx-separator px-3 py-2 last:border-0">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gx-accent-bg text-gx-12 font-medium text-gx-accent">
                {(a.displayName || a.email || "?").charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-gx-13 text-gx-text-primary">{a.displayName || a.email}</div>
                <div className="truncate text-gx-11 text-gx-text-hint">{a.email}</div>
              </div>
              <span className="text-gx-12 text-gx-text-secondary">{roleLabel(a.role)}</span>
              <button
                type="button"
                onClick={() => revoke(a.userId, a.email)}
                className="rounded p-1 text-gx-text-tertiary hover:bg-gx-danger-bg hover:text-gx-danger"
                title="撤销独立权限"
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}


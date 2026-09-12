// apps/web/src/features/settings/SharePanel.tsx
// 分享链接管理：列出链接（角色徽标 + 复制）+ 创建（角色 + 可选过期时间）
// 说明：useGXMutations.createShareLink 不支持 expiresAt，故创建走 client 并手动失效缓存

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bases } from "../../api/client";
import { QK, useShareLinks, useGXMutations } from "../../api/hooks";
import { Badge, Input, Select, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ROLE_LABEL, type Role } from "@gx/shared-types";

const SHARE_ROLES: Role[] = ["editor", "commenter", "viewer"];

function fmtTime(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function SharePanel({ baseId, canManageBase }: { baseId: string; canManageBase: boolean }) {
  const { data: links } = useShareLinks(baseId);
  const m = useGXMutations();
  const qc = useQueryClient();

  const [role, setRole] = useState<Role>("editor");
  const [expiresAt, setExpiresAt] = useState("");

  async function copyLink(token: string) {
    const url = `${location.origin}/join/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("已复制", "success");
    } catch {
      toast("复制失败，请手动复制", "error");
    }
  }

  async function create() {
    try {
      // 直接调用 client 以携带 expiresAt（hooks mutation 暂不支持该字段）
      await Bases.createShareLink(baseId, {
        role: role as "editor" | "commenter" | "viewer",
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      await qc.invalidateQueries({ queryKey: QK.shareLinks(baseId) });
      setExpiresAt("");
      toast("已创建分享链接", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "创建失败", "error");
    }
  }

  async function remove(linkId: string) {
    try {
      await m.removeShareLink.mutateAsync({ baseId, linkId });
      toast("已删除链接", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  if (!canManageBase) {
    return (
      <div className="rounded-gx-md border border-gx-border bg-gx-bg px-3 py-3 text-gx-13 text-gx-text-secondary">
        只有所有者可管理分享链接
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 创建区 */}
      <div className="rounded-gx-lg border border-gx-border p-4">
        <div className="mb-3 text-gx-14 font-medium text-gx-text-primary">创建分享链接</div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <div className="mb-1 text-gx-12 text-gx-text-tertiary">角色</div>
            <Select
              value={role}
              options={SHARE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              onChange={(e) => setRole(e.target.value as Role)}
            />
          </div>
          <div>
            <div className="mb-1 text-gx-12 text-gx-text-tertiary">过期时间（可选）</div>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="h-8 rounded-gx-md border border-gx-border bg-gx-surface px-2 text-gx-13 text-gx-text-primary focus:border-gx-accent focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={create}
            className="rounded-gx-md bg-gx-accent px-3 py-2 text-gx-13 font-medium text-white hover:brightness-95"
          >
            创建链接
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="rounded-gx-lg border border-gx-border">
        <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-2 text-gx-12 font-medium text-gx-text-secondary">
          <span className="w-20">角色</span>
          <span className="flex-1">链接</span>
          <span className="w-36">创建时间</span>
          <span className="w-36">过期时间</span>
          <span className="w-20 text-right">操作</span>
        </div>

        {(links ?? []).map((l) => (
          <div key={l.id} className="flex items-center gap-3 border-b border-gx-separator px-3 py-2 last:border-0">
            <span className="w-20">
              <Badge>{ROLE_LABEL[l.role]}</Badge>
            </span>
            <button
              type="button"
              onClick={() => copyLink(l.token)}
              className="flex flex-1 items-center gap-1.5 truncate text-left text-gx-13 text-gx-accent hover:underline"
              title="点击复制链接"
            >
              <Icon name="link" size={13} />
              <span className="truncate">{location.origin}/join/{l.token}</span>
            </button>
            <span className="w-36 text-gx-12 text-gx-text-tertiary">{fmtTime(l.createdAt)}</span>
            <span className="w-36 text-gx-12 text-gx-text-tertiary">{l.expiresAt ? fmtTime(l.expiresAt) : "永不"}</span>
            <div className="flex w-20 items-center justify-end gap-1">
              <button type="button" onClick={() => copyLink(l.token)} className="text-gx-12 text-gx-text-tertiary hover:text-gx-accent" title="复制">
                <Icon name="copy" size={14} />
              </button>
              <button type="button" onClick={() => remove(l.id)} className="text-gx-12 text-gx-danger hover:underline" title="删除">
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}

        {(!links || links.length === 0) && (
          <div className="px-3 py-6 text-center text-gx-13 text-gx-text-hint">还没有分享链接</div>
        )}
      </div>
    </div>
  );
}

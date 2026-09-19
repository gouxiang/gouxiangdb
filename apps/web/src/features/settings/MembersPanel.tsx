// apps/web/src/features/settings/MembersPanel.tsx
// 成员与权限管理：成员列表 + 角色下拉 + 邀请 + 5 角色 × 5 权限矩阵
// 规则：owner 不可改角色/移除；非 canManageBase 整面板只读

import { useState } from "react";
import { useMembers, useGXMutations } from "../../api/hooks";
import { Input, Select, toast } from "../../components/ui";
import { confirmAction } from "../../components/feedback";
import { Icon } from "../../components/icons";
import {
  ROLES,
  ROLE_LABEL,
  ROLE_DESCRIPTION,
  permissionsForRole,
  type Role,
  type PermissionSet,
} from "@gx/shared-types";
import { AVATAR_PALETTE } from "@gx/design-tokens";

// 矩阵列定义
const PERM_COLS: { key: keyof PermissionSet; label: string }[] = [
  { key: "canManageBase", label: "管理 Base" },
  { key: "canManageSchema", label: "管理结构" },
  { key: "canEditData", label: "编辑数据" },
  { key: "canComment", label: "评论" },
  { key: "canView", label: "查看" },
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export function MembersPanel({ baseId, canManageBase }: { baseId: string; canManageBase: boolean }) {
  const { data: members, isLoading } = useMembers(baseId);
  const m = useGXMutations();

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");

  async function changeRole(memberId: string, role: Role) {
    try {
      await m.updateMember.mutateAsync({ baseId, memberId, role });
      toast("已更新角色", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "更新失败", "error");
    }
  }

  async function remove(memberId: string, label: string) {
    // 移除成员无撤销接口（回收站只收 record/table/field），故必须显式确认；
    // 可重新邀请，按 L2 普通确认而非 L4。R-D-24：主按钮用具体动词「移除成员」。
    const ok = await confirmAction({
      title: "移除成员",
      confirmText: "移除成员",
      cancelText: "取消",
      level: 2,
      description: `${label} 将失去本库的访问权限，可重新邀请恢复。`,
    });
    if (!ok) return;
    try {
      await m.removeMember.mutateAsync({ baseId, memberId });
      toast("已移除成员", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "移除失败", "error");
    }
  }

  async function invite() {
    if (!email.trim()) return;
    try {
      await m.inviteMember.mutateAsync({ baseId, email: email.trim(), role: inviteRole });
      setEmail("");
      toast("已发送邀请", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "邀请失败", "error");
    }
  }

  const roleOptions = ROLES.filter((r) => r !== "owner").map((r) => ({ value: r, label: ROLE_LABEL[r] }));

  return (
    <div className="flex flex-col gap-6">
      {!canManageBase && (
        <div className="rounded-gx-lg border border-gx-border bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-secondary">
          你不是 Base 所有者，只能查看成员与权限，无法修改。
        </div>
      )}

      {/* 成员列表 */}
      <div className="rounded-gx-lg border border-gx-border">
        <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-2 text-gx-12 font-medium text-gx-text-secondary">
          <span className="flex-1">成员</span>
          <span className="w-[140px]">角色</span>
          {canManageBase && <span className="w-16 text-right">操作</span>}
        </div>

        {isLoading && <div className="px-3 py-6 text-center text-gx-13 text-gx-text-hint">加载中…</div>}

        {(members ?? []).map((mem) => {
          const isOwner = mem.role === "owner";
          return (
            <div key={mem.id} className="flex items-center gap-3 border-b border-gx-separator px-3 py-2">
              <div className="flex flex-1 items-center gap-2">
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gx-12 font-semibold text-white"
                  style={{ backgroundColor: avatarColor(mem.displayName || mem.email) }}
                >
                  {(mem.displayName || mem.email).charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-gx-13 font-medium text-gx-text-primary">{mem.displayName}</span>
                    {isOwner && (
                      <span className="rounded-full bg-gx-accent-bg px-1.5 py-0.5 text-gx-11 text-gx-accent">所有者</span>
                    )}
                  </div>
                  <div className="truncate text-gx-12 text-gx-text-tertiary">{mem.email}</div>
                </div>
              </div>

              <div className="w-[140px]" title={ROLE_DESCRIPTION[mem.role]}>
                {/* 权限治理第二批：改成员角色属管理类操作，无权限（或对所有者行）不给灰掉的下拉，
                    改为只读文本展示当前角色。 */}
                {canManageBase && !isOwner ? (
                  <Select
                    value={mem.role}
                    options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                    onChange={(e) => changeRole(mem.id, e.target.value as Role)}
                  />
                ) : (
                  <span className="select-text text-gx-13 text-gx-text-primary">{ROLE_LABEL[mem.role]}</span>
                )}
              </div>

              {canManageBase && !isOwner && (
                <div className="w-16 text-right">
                  <button
                    type="button"
                    title="移除成员"
                    onClick={() => void remove(mem.id, mem.email || "该成员")}
                    className="text-gx-12 text-gx-danger hover:underline"
                  >
                    移除
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 邀请表单（仅所有者可见） */}
      {canManageBase && (
        <div className="flex items-end gap-2 rounded-gx-lg border border-gx-border p-3">
          <div className="flex-1">
            <div className="mb-1 text-gx-12 text-gx-text-tertiary">邮箱</div>
            <Input
              type="email"
              placeholder="invite@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="w-[140px]">
            <div className="mb-1 text-gx-12 text-gx-text-tertiary">角色</div>
            <Select value={inviteRole} options={roleOptions} onChange={(e) => setInviteRole(e.target.value as Role)} />
          </div>
          <button
            type="button"
            onClick={invite}
            className="rounded-gx-lg bg-gx-accent px-3 py-2 text-gx-13 font-medium text-white hover:brightness-95"
          >
            邀请
          </button>
        </div>
      )}

      {/* 权限说明矩阵 */}
      <div>
        <div className="mb-2 text-gx-14 font-medium text-gx-text-primary">权限说明</div>
        <div className="overflow-x-auto rounded-gx-lg border border-gx-border">
          <table className="w-full border-collapse text-gx-12">
            <thead>
              <tr className="bg-gx-table-header">
                <th className="border-b border-gx-separator px-3 py-2 text-left font-medium text-gx-text-secondary">角色</th>
                {PERM_COLS.map((c) => (
                  <th key={c.key} className="border-b border-gx-separator px-3 py-2 text-center font-medium text-gx-text-secondary">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => {
                const ps = permissionsForRole(role);
                return (
                  <tr key={role} className="border-b border-gx-separator last:border-0">
                    <td className="px-3 py-2 text-gx-text-primary">
                      <div className="font-medium">{ROLE_LABEL[role]}</div>
                      <div className="text-gx-11 text-gx-text-hint">{ROLE_DESCRIPTION[role]}</div>
                    </td>
                    {PERM_COLS.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-center">
                        {ps[c.key] ? (
                          <Icon name="check" size={15} className="mx-auto text-gx-success" />
                        ) : (
                          <span className="text-gx-text-hint">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

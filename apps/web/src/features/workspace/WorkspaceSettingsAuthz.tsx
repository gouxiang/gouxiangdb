// apps/web/src/features/workspace/WorkspaceSettingsAuthz.tsx
// 工作区设置 →「权限管理」分区：全站唯一的权限配置入口。
//
// 分三块，各自对应一层真实的权限切面（不是同一份数据的三种视图）：
//   1. 角色与组织权限 —— 组织级角色 + 组织动作（新建库、查看通讯录…），挂 RoleManager；
//   2. 库与知识库成员权限 —— 单个库/知识库的成员角色与分享链接（旧三表，实际生效），
//      挂 MembersPanel / SharePanel（库）或知识库成员区块；
//   3. 资源授权策略 —— 资源树上的细粒度授权，挂 PermPanel。
// 抽成本文件的原因：WorkspaceSettingsPage 只负责「分区调度 + 布局」，且这一块内联会顶过 300 行上限。

import { useState } from "react";
import { Icon } from "../../components/icons";
import { Button, EmptyState, Input, Select, Spinner, toast } from "../../components/ui";
import { useBases } from "../../api/hooks";
import { useKbList, useAddKbMember, useKbMembers, useRemoveKbMember } from "../kb/kb-hooks";
import { KB_ROLE_RANK, roleLabel } from "../kb/kb-ui";
import { RoleManager } from "../contacts/RoleManager";
import { MembersPanel } from "../settings/MembersPanel";
import { SharePanel } from "../settings/SharePanel";
import PermPanel from "../authz/PermPanel";
import { confirmAction } from "../../components/feedback";
import { useAuthStore } from "../../store/auth";

/** 权限三块的统一外壳：小标题 + 一句大白话说明。 */
function Block({
  title,
  icon,
  desc,
  children,
}: {
  title: string;
  icon: "users" | "database" | "shield";
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <Icon name={icon} size={15} className="mt-0.5 shrink-0 text-gx-accent" />
        <div className="min-w-0">
          <h3 className="text-gx-14 font-semibold text-gx-text-primary">{title}</h3>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">{desc}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export function AuthzSection({ canManageRoles }: { canManageRoles: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <h2 className="text-gx-18 font-semibold text-gx-text-primary">权限管理</h2>
        <p className="mt-1 text-gx-13 text-gx-text-tertiary">
          在这里统一配置：通讯录角色权限、各库的成员与分享、资源授权策略。
        </p>
      </div>

      <Block
        title="角色与组织权限"
        icon="users"
        desc="新建角色、给角色勾选组织动作（新建库、查看通讯录等），再把角色授给成员或部门。"
      >
        <div className="h-[420px] overflow-hidden rounded-gx-lg border border-gx-separator">
          <RoleManager canManageRoles={canManageRoles} />
        </div>
      </Block>

      <Block
        title="库与知识库成员权限"
        icon="database"
        desc="选中一个库或知识库，配置谁能看、谁能改、谁能分享。改完立刻生效。"
      >
        <LibraryPermPicker />
      </Block>

      <Block title="资源授权策略" icon="shield" desc="按资源树查看与下发细粒度授权策略。">
        <div className="h-[560px] overflow-hidden rounded-gx-lg border border-gx-separator">
          <PermPanel embedded />
        </div>
      </Block>
    </div>
  );
}

// ==================== 第二块：库 / 知识库选择器 + 成员与分享 ====================

type Target = { kind: "base" | "kb"; id: string };

function parseTarget(value: string): Target | null {
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  if (kind !== "base" && kind !== "kb") return null;
  return id ? { kind, id } : null;
}

/**
 * 选择器不做「选中态 → state」的双向同步：target 由 `value ?? 首个选项` 直接推导，
 * 列表异步到达后自然落到第一项，不存在「先选了又被 effect 覆盖」或「空列表时残留旧 id」。
 */
function LibraryPermPicker() {
  const { data: bases, isLoading: loadingBases } = useBases();
  const { data: kbs, isLoading: loadingKbs } = useKbList();
  const [value, setValue] = useState("");

  if (loadingBases || loadingKbs) {
    return (
      <div className="flex h-24 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }

  const groups = [
    {
      label: "数据库",
      options: (bases ?? []).map((b) => ({ value: `base:${b.id}`, label: b.name })),
    },
    {
      label: "知识库",
      options: (kbs ?? []).map((k) => ({ value: `kb:${k.id}`, label: k.name })),
    },
  ].filter((g) => g.options.length > 0);

  const first = groups[0]?.options[0]?.value ?? "";
  const target = parseTarget(value) ?? parseTarget(first);

  if (!target) {
    return (
      <EmptyState
        icon="database"
        title="还没有数据库或知识库"
        description="先在一级导航新建一个库，再回来给它的成员配权限。"
      />
    );
  }

  const base = target.kind === "base" ? (bases ?? []).find((b) => b.id === target.id) : undefined;
  const kb = target.kind === "kb" ? (kbs ?? []).find((k) => k.id === target.id) : undefined;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-gx-12 text-gx-text-tertiary">选择要配置的库</span>
        <Select
          groups={groups}
          value={value || first}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 max-w-sm"
          aria-label="选择要配置权限的数据库或知识库"
        />
      </label>

      {base && (
        <div className="flex flex-col gap-4 rounded-gx-lg border border-gx-separator p-3">
          <MembersPanel baseId={base.id} canManageBase={base.permissions?.canManageBase ?? false} />
          <SharePanel baseId={base.id} canManageBase={base.permissions?.canManageBase ?? false} />
        </div>
      )}
      {kb && <KbMembersBlock kbId={kb.id} myRole={kb.role ?? "owner"} />}
    </div>
  );
}

/**
 * 知识库成员区块：MembersPanel/SharePanel 打的是 /bases/:id/* 端点，对知识库不适用，
 * 这里用 kb-hooks 的同一批接口（列表 / 按邮箱添加 / 移除）做等价视图，口径与
 * 知识库设置页时期完全一致（owner 才能增删，不能移除自己）。
 */
function KbMembersBlock({ kbId, myRole }: { kbId: string; myRole: string }) {
  const me = useAuthStore((s) => s.user);
  const { data: members, isLoading } = useKbMembers(kbId);
  const addMember = useAddKbMember(kbId);
  const removeMember = useRemoveKbMember(kbId);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "commenter" | "viewer">("editor");
  const isOwner = myRole === "owner";

  async function add() {
    const e = email.trim();
    if (!e || addMember.isPending) return;
    try {
      await addMember.mutateAsync({ email: e, role });
      toast("已添加成员", "success");
      setEmail("");
    } catch (err) {
      toast(err instanceof Error ? err.message : "添加失败，请确认邮箱已注册", "error");
    }
  }

  async function remove(userId: string, label: string) {
    if (userId === me?.id) return;
    const ok = await confirmAction({
      title: "移除成员",
      confirmText: "移除成员",
      cancelText: "取消",
      level: 2,
      description: `${label} 将失去本知识库的访问权限，可重新添加恢复。`,
    });
    if (!ok) return;
    try {
      await removeMember.mutateAsync(userId);
      toast("已移除成员", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "移除失败", "error");
    }
  }

  return (
    <div className="rounded-gx-lg border border-gx-separator">
      <div className="border-b border-gx-separator px-4 py-3 text-gx-13 font-medium text-gx-text-primary">
        知识库成员
      </div>
      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner size={20} />
        </div>
      ) : (
        <div>
          {(members ?? []).map((m) => {
            const isSelf = m.userId === me?.id;
            const canRemove = isOwner && !isSelf && (KB_ROLE_RANK[m.role] ?? 0) < KB_ROLE_RANK.owner;
            return (
              <div
                key={m.userId}
                className="flex items-center gap-3 border-b border-gx-separator px-4 py-2.5 last:border-0"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gx-accent-bg text-gx-13 font-semibold text-gx-accent">
                  {(m.displayName || m.email || "?").charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-gx-13 text-gx-text-primary">
                    {m.displayName || m.email}
                    {isSelf && <span className="ml-1.5 text-gx-11 text-gx-text-hint">（我）</span>}
                  </div>
                  <div className="truncate text-gx-11 text-gx-text-hint">{m.email}</div>
                </div>
                <span className="text-gx-12 text-gx-text-secondary">{roleLabel(m.role)}</span>
                {canRemove && (
                  <button
                    type="button"
                    aria-label={`移除成员 ${m.displayName || m.email || "该成员"}`}
                    onClick={() => void remove(m.userId, m.displayName || m.email || "该成员")}
                    className="rounded p-1 text-gx-text-tertiary hover:bg-gx-danger-bg hover:text-gx-danger"
                    title="移除成员"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            );
          })}
          {(members ?? []).length === 0 && (
            <EmptyState
              icon="users"
              title="暂无其他成员"
              description="用下方表单按邮箱添加成员，并为其指定可编辑 / 可评论 / 仅查看。"
            />
          )}
        </div>
      )}

      {isOwner && (
        <div className="flex flex-col gap-1 border-t border-gx-separator px-4 py-3">
          <div className="text-gx-13 font-medium text-gx-text-primary">添加成员</div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="成员注册邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              className="flex-1"
              aria-label="成员注册邮箱"
            />
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              options={[
                { value: "editor", label: "可编辑" },
                { value: "commenter", label: "可评论" },
                { value: "viewer", label: "仅查看" },
              ]}
              className="h-8"
              aria-label="成员角色"
            />
            <Button variant="primary" icon="plus" disabled={!email.trim()} onClick={() => void add()}>
              添加
            </Button>
          </div>
          <p className="text-gx-11 text-gx-text-hint">
            成员需已注册账号。知识库角色对全部内容生效；如需对单篇文档/画布单独授权，请在内容列表的「独立权限」中设置。
          </p>
        </div>
      )}
    </div>
  );
}

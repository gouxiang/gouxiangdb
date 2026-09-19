// apps/web/src/features/kb/KbSettingsPage.tsx
// /kb/:kbId/settings —— 知识库成员管理：添加成员（邮箱+角色）、移除成员、角色展示。
// 单文档/画布的独立权限在内容列表与编辑器中按条目管理。

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { EmptyState, Input, Select, Spinner, toast } from "../../components/ui";
import { EntityIconPicker } from "../../components/EntityIconPicker";
import { useKb, useKbMembers, useAddKbMember, useRemoveKbMember, useUpdateKb } from "./kb-hooks";
import { roleLabel, KB_ROLE_RANK } from "./kb-ui";
import { UploadLimitsPanel } from "./UploadLimitsPanel";
import { confirmAction } from "../../components/feedback";
import { useAuthStore } from "../../store/auth";

const ADD_ROLES = [
  { value: "editor", label: "可编辑" },
  { value: "commenter", label: "可评论" },
  { value: "viewer", label: "仅查看" },
];

export default function KbSettingsPage() {
  const { kbId } = useParams();
  const me = useAuthStore((s) => s.user);
  const { data: kb } = useKb(kbId);
  const { data: members, isLoading } = useKbMembers(kbId);
  const addMember = useAddKbMember(kbId!);
  const removeMember = useRemoveKbMember(kbId!);
  const updateKb = useUpdateKb(kbId!);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "commenter" | "viewer">("editor");
  const [name, setName] = useState(kb?.name ?? "");

  const myRole = kb?.role ?? "owner";
  const isOwner = myRole === "owner";

  // 知识库加载 / 切库 / 他人改名后同步名称输入
  useEffect(() => {
    if (kb) setName(kb.name);
  }, [kb]);

  async function saveKb() {
    if (!kbId || !isOwner || !name.trim()) return;
    try {
      await updateKb.mutateAsync({ name: name.trim() });
      toast("已保存", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败", "error");
    }
  }

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
    // 与库成员同一口径：无撤销接口 → 显式确认；可重新邀请 → L2 而非 L4。
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
    <div className="h-full overflow-y-auto bg-gx-bg">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <div className="mb-5 flex items-center gap-2">
          <Icon name="users" size={18} className="text-gx-accent" />
          <h1 className="text-gx-16 font-semibold text-gx-text-primary">成员与权限</h1>
          <span className="text-gx-12 text-gx-text-hint">{kb?.name}</span>
        </div>

        {/* 上传限制（本机浏览器生效，跨全部知识库） */}
        <div className="mb-4">
          <UploadLimitsPanel />
        </div>

        {/* 基本信息：名称 + 实体图标与颜色（图标/选色即时写库，失败由 EntityIconPicker toast） */}
        <div className="mb-4 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-3">
          <div className="mb-2 text-gx-13 font-medium text-gx-text-primary">基本信息</div>
          <div className="flex items-center gap-3">
            <EntityIconPicker
              icon={kb?.icon ?? null}
              iconColor={kb?.iconColor ?? null}
              defaultIcon="book"
              ariaLabel="知识库图标与颜色"
              readOnly={!isOwner}
              onChange={(next) =>
                // iconColor 原样透传（含 null = 恢复默认色）。旧注释「后端 z.string().optional()」
                // 已过时：后端改 entityIconColorSchema 后接受 null，并对 NOT NULL 的
                // knowledge_bases.iconColor 列映射成系统默认色 #0F6E56。
                updateKb.mutateAsync({ icon: next.icon, iconColor: next.iconColor })
              }
            />
            <Input
              value={name}
              disabled={!isOwner}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKb()}
              className="flex-1"
              aria-label="知识库名称"
            />
            {isOwner && (
              <button
                type="button"
                disabled={!name.trim() || name.trim() === kb?.name}
                onClick={saveKb}
                className="inline-flex h-8 items-center rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-40"
              >
                保存
              </button>
            )}
          </div>
          <p className="mt-2 text-gx-11 text-gx-text-hint">
            图标与颜色选择后立即生效，名称需点「保存」；「恢复默认」清除自定义图标。
          </p>
        </div>

        <div className="rounded-gx-lg border border-gx-border bg-gx-surface">
          <div className="border-b border-gx-separator px-4 py-3 text-gx-13 font-medium text-gx-text-primary">
            知识库成员
          </div>

          {isLoading ? (
            <div className="flex justify-center py-10"><Spinner size={20} /></div>
          ) : (
            <div>
              {(members ?? []).map((m) => {
                const isSelf = m.userId === me?.id;
                const rank = KB_ROLE_RANK[m.role] ?? 0;
                const canRemove = isOwner && !isSelf && rank < KB_ROLE_RANK.owner;
                return (
                  <div key={m.userId} className="flex items-center gap-3 border-b border-gx-separator px-4 py-2.5 last:border-0">
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
                        // P3-a11y：成员行尾纯图标按钮，带上成员名，读屏能念出「移除谁」
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
                  description="用上方表单按邮箱添加成员，并为其指定可编辑 / 可评论 / 仅查看。"
                />
              )}
            </div>
          )}
        </div>

        {isOwner && (
          <div className="mt-4 rounded-gx-lg border border-gx-border bg-gx-surface px-4 py-3">
            <div className="mb-2 text-gx-13 font-medium text-gx-text-primary">添加成员</div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="成员注册邮箱"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                className="flex-1"
              />
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as typeof role)}
                options={ADD_ROLES}
                className="h-8"
              />
              <button
                type="button"
                disabled={!email.trim() || addMember.isPending}
                onClick={add}
                className="inline-flex h-8 items-center gap-1 rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-40"
              >
                <Icon name="plus" size={14} />
                添加
              </button>
            </div>
            <p className="mt-2 text-gx-11 text-gx-text-hint">
              成员需已注册账号。知识库角色对全部内容生效；如需对单篇文档/画布单独授权，请在内容列表的「独立权限」中设置。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

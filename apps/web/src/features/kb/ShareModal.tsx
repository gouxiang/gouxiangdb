// apps/web/src/features/kb/ShareModal.tsx
// 分享弹窗：①内部成员（团队）仅可见/可编辑 ②外部链接 开关/复制/权限/级联分享下级。
// 内部访问以知识库团队角色为准；外部链接以分享设置为准（两套独立）。

import { useEffect, useState } from "react";
import { Modal, Button, Switch, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useShareState, useSetShare, useSetInternalShare } from "./kb-hooks";
import { withBase } from "../../api/client";

export function ShareModal({ docId, kbId, kind = "doc", open, onClose }: { docId: string; kbId: string; kind?: "doc" | "canvas"; open: boolean; onClose: () => void }) {
  const { data, isLoading } = useShareState(open ? docId : undefined);
  const setShare = useSetShare(docId, kbId);
  const setInternal = useSetInternalShare(docId);

  const [enabled, setEnabled] = useState(false);
  const [linkRole, setLinkRole] = useState<"viewer" | "editor">("viewer");
  const [includeChildren, setIncludeChildren] = useState(false);
  const [internalRole, setInternalRole] = useState<"viewer" | "editor">("editor");

  useEffect(() => {
    if (data?.share) {
      setEnabled(data.share.shareEnabled);
      setLinkRole(data.share.shareRole);
      setIncludeChildren(data.share.shareIncludeChildren);
    }
    if (data?.internal) {
      setInternalRole(data.internal.membersCanEdit ? "editor" : "viewer");
    }
  }, [data]);

  const share = data?.share;
  const canManage = share?.canManage ?? true;
  // 子路径部署（/app/gouxiangdb）下公开分享链接必须带网关前缀。
  const fullUrl = share?.shareToken ? `${window.location.origin}${withBase(`/s/${share.shareToken}`)}` : "";

  async function copyLink() {
    if (!fullUrl) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
      toast("链接已复制", "success");
    } catch {
      toast("复制失败，请手动选择链接复制", "error");
    }
  }

  async function toggleShare(next: boolean) {
    setEnabled(next);
    try {
      await setShare.mutateAsync({
        shareEnabled: next,
        shareRole: linkRole,
        shareIncludeChildren: includeChildren,
      });
      toast(next ? "链接分享已开启" : "链接分享已关闭", next ? "success" : "info");
    } catch (e) {
      setEnabled(!next);
      toast(e instanceof Error ? e.message : "操作失败", "error");
    }
  }

  async function updateLinkRole(role: "viewer" | "editor") {
    setLinkRole(role);
    if (!enabled) return;
    try {
      await setShare.mutateAsync({ shareEnabled: true, shareRole: role, shareIncludeChildren: includeChildren });
    } catch (e) {
      toast(e instanceof Error ? e.message : "操作失败", "error");
    }
  }

  async function toggleIncludeChildren(next: boolean) {
    setIncludeChildren(next);
    if (!enabled) return;
    try {
      await setShare.mutateAsync({ shareEnabled: true, shareRole: linkRole, shareIncludeChildren: next });
    } catch (e) {
      setIncludeChildren(!next);
      toast(e instanceof Error ? e.message : "操作失败", "error");
    }
  }

  async function applyInternalRole(role: "viewer" | "editor") {
    const prev = internalRole;
    setInternalRole(role);
    try {
      await setInternal.mutateAsync(role);
      toast(role === "editor" ? "团队成员已设为可编辑" : "团队成员已设为仅可见", "success");
    } catch (e) {
      setInternalRole(prev);
      toast(e instanceof Error ? e.message : "调整团队权限需知识库所有者", "error");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="分享" width={520} footer={<Button onClick={onClose}>完成</Button>}>
      {isLoading || !share ? (
        <div className="py-10 text-center text-gx-13 text-gx-text-hint">加载中…</div>
      ) : (
        <div className="space-y-5">
          {/* ① 内部成员 */}
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-gx-13 font-semibold text-gx-text-primary">
              <Icon name="users" size={15} className="text-gx-text-secondary" />
              内部成员
              <span className="font-normal text-gx-text-hint">（知识库团队 · 共 {data?.internal?.memberCount ?? 0} 人）</span>
            </div>
            <div className="rounded-gx-md border border-gx-separator bg-gx-bg p-1">
              <RoleOption
                active={internalRole === "viewer"}
                title="仅可见"
                desc="团队成员可查看，不能编辑"
                disabled={!canManage}
                onClick={() => applyInternalRole("viewer")}
              />
              <RoleOption
                active={internalRole === "editor"}
                title="可编辑"
                desc="团队成员可查看并编辑内容"
                disabled={!canManage}
                onClick={() => applyInternalRole("editor")}
              />
            </div>
            <p className="mt-1.5 text-gx-11 text-gx-text-hint">内部访问以知识库成员角色为准，分享设置不会降低已有权限。</p>
          </section>

          {/* ② 外部链接 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-gx-13 font-semibold text-gx-text-primary">
                <Icon name="globe" size={15} className="text-gx-text-secondary" />
                外部链接
              </div>
              <Switch checked={enabled} onChange={toggleShare} />
            </div>

            {enabled ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-gx-md border border-gx-separator bg-gx-bg px-2.5 py-2">
                  <Icon name="link" size={14} className="shrink-0 text-gx-text-tertiary" />
                  <input
                    readOnly
                    value={fullUrl}
                    onFocus={(e) => e.target.select()}
                    className="min-w-0 flex-1 bg-transparent text-gx-12 text-gx-text-secondary outline-none"
                  />
                  <Button size="sm" variant="secondary" onClick={copyLink}>
                    <Icon name="copy" size={13} />
                    复制
                  </Button>
                </div>

                <div>
                  <div className="mb-1.5 text-gx-12 text-gx-text-secondary">持链者权限</div>
                  <div className="rounded-gx-md border border-gx-separator bg-gx-bg p-1">
                    <RoleOption
                      active={linkRole === "viewer"}
                      title="仅可见"
                      desc="获得链接的人仅可查看"
                      disabled={!canManage}
                      onClick={() => updateLinkRole("viewer")}
                    />
                    <RoleOption
                      active={linkRole === "editor"}
                      title="可编辑"
                      desc="获得链接的人无需登录即可编辑"
                      disabled={!canManage}
                      onClick={() => updateLinkRole("editor")}
                    />
                  </div>
                </div>

                {kind === "doc" && (
                  <label className={`flex items-start gap-2.5 rounded-gx-md border border-gx-separator p-2.5 ${canManage ? "cursor-pointer hover:bg-gx-bg" : "opacity-60"}`}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-[var(--gx-accent)]"
                      checked={includeChildren}
                      disabled={!canManage || setShare.isPending}
                      onChange={(e) => toggleIncludeChildren(e.target.checked)}
                    />
                    <span className="text-gx-12 leading-relaxed text-gx-text-secondary">
                      <span className="font-medium text-gx-text-primary">同步分享下级文档</span>
                      <br />
                      勾选后，本级及其全部下级文档一并开启链接分享；访问页左侧展示文档树。
                    </span>
                  </label>
                )}
              </div>
            ) : (
              <div className="rounded-gx-md border border-dashed border-gx-border bg-gx-bg px-3 py-3 text-gx-12 text-gx-text-hint">
                开启后，任何人通过链接即可访问（无需登录）。关闭后原链接立即失效。
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function RoleOption({
  active,
  title,
  desc,
  onClick,
  disabled,
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-gx-sm px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? "bg-gx-accent-bg" : "hover:bg-gx-surface"
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          active ? "border-gx-accent" : "border-gx-border"
        }`}
      >
        {active && <span className="h-2 w-2 rounded-full bg-gx-accent" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-gx-13 ${active ? "font-medium text-gx-text-primary" : "text-gx-text-primary"}`}>{title}</span>
        <span className="block text-gx-11 text-gx-text-hint">{desc}</span>
      </span>
    </button>
  );
}

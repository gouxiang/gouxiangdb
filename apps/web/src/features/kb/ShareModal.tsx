// apps/web/src/features/kb/ShareModal.tsx
// 分享弹窗：①内部成员（团队）仅可见/可编辑 ②外部链接 开关/复制/权限/级联分享下级。
// 内部访问以知识库团队角色为准；外部链接以分享设置为准（两套独立）。

import { useEffect, useRef, useState } from "react";
import { Modal, Button, Switch, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useShareState, useSetShare, useSetInternalShare } from "./kb-hooks";
import { withBase } from "../../api/client";
import { COPY_FAIL_HINT_LINK, copyText } from "../../lib/clipboard";
import { ShareDegradedNote, ShareModeField } from "../sharing/ShareModeField";
import { shareErrorMessage } from "../sharing/share-hooks";

export function ShareModal({ docId, kbId, kind = "doc", open, onClose }: { docId: string; kbId: string; kind?: "doc" | "canvas"; open: boolean; onClose: () => void }) {
  const { data, isLoading } = useShareState(open ? docId : undefined);
  const setShare = useSetShare(docId, kbId);
  const setInternal = useSetInternalShare(docId);

  const [enabled, setEnabled] = useState(false);
  const [linkRole, setLinkRole] = useState<"viewer" | "editor">("viewer");
  const [includeChildren, setIncludeChildren] = useState(false);
  const [internalRole, setInternalRole] = useState<"viewer" | "editor">("editor");
  // 复制失败时用于自动选中链接文本，让用户可直接按 Ctrl/⌘ + C。
  const linkInputRef = useRef<HTMLInputElement>(null);

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

  // 降级：申请了「可编辑」但分享人后来失去了编辑权 → 后端每次访问现算，链接已回落只读
  // （resolveDocShareCaps）。这里只显示结论，不重算权限。
  const degraded = share?.degraded === true;
  // 「可编辑」能不能开：后端 GET 只给「本次生效档位 + 是否已降级」两个结论，没有单发一个
  // 「本人此刻能否授予编辑」的位。唯一能确定的是：申请过 edit 且已降级 → 本人没有编辑权，
  // 必须置灰。其余情形不假装判准——后端 POST 会再判一次（assertSharerCanGrantDocEdit），
  // 403 的原文由 updateLinkRole 原样 toast 出来。
  const canGrantEdit = !(share?.requestedMode === "edit" && degraded);

  async function copyLink() {
    if (!fullUrl) return;
    // 局域网 HTTP 下 navigator.clipboard 不存在（非安全上下文），必须走三级降级。
    const ok = await copyText(fullUrl);
    if (ok) {
      toast("链接已复制", "success");
      return;
    }
    toast(COPY_FAIL_HINT_LINK, "error");
    // 自动选中只读输入框文本（onFocus 也会 select），用户可直接按 Ctrl/⌘ + C。
    linkInputRef.current?.focus();
    linkInputRef.current?.select();
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
      // 本人没编辑权时后端 403 的原文（「只有本人对该知识库内容有编辑权时才能创建可编辑分享」）
      // 就是给用户的答案：置灰只是提示，后端才是防线，不要换成前端自己的措辞。
      toast(shareErrorMessage(e, "操作失败"), "error");
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
              {/* 人数不再显示：逐库逐人的成员名册下线后，后端这个接口没有人数可回。 */}
            </div>
            <div className="rounded-gx-lg border border-gx-separator bg-gx-bg p-1">
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
                <div className="flex items-center gap-2 rounded-gx-lg border border-gx-separator bg-gx-bg px-2.5 py-2">
                  <Icon name="link" size={14} className="shrink-0 text-gx-text-tertiary" />
                  <input
                    ref={linkInputRef}
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
                  {/* 两档恢复到界面：可编辑要求分享人本人此刻有编辑权，且不是一锤子买卖——
                      分享人之后被降权，链接每次访问重算并自动回落只读（后端 resolveDocShareCaps）。
                      置灰不是防线，后端 POST 会再判一次并把 403 原文回给这里。 */}
                  <ShareModeField
                    value={linkRole === "editor" ? "edit" : "view"}
                    onChange={(m) => updateLinkRole(m === "edit" ? "editor" : "viewer")}
                    canGrantEdit={canGrantEdit}
                    disabled={!canManage}
                    disabledReason="你本人对这个知识库没有编辑权，因此不能创建可编辑的分享链接"
                    viewDesc="获得链接的人无需登录即可查看，不能编辑"
                    editDesc="持链者可写这篇文档里嵌入的数据表；正文仍不可改"
                    // 作用范围必须写清楚：文档正文的匿名写后端仍关闭（publicDoc.ts canEdit 恒 false），
                    // 这个档位驱动的是「文档/画布里嵌入的数据表预览能不能写」，不是正文。
                    scopeNote="说明：文档正文的匿名编辑仍然关闭，「可编辑」档位决定的是这篇文档 / 画布里嵌入的数据表能不能改。"
                  />
                  {degraded ? <ShareDegradedNote /> : null}
                </div>

                {kind === "doc" && (
                  <label className={`flex items-start gap-2.5 rounded-gx-lg border border-gx-separator p-2.5 ${canManage ? "cursor-pointer hover:bg-gx-bg" : "opacity-60"}`}>
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
              <div className="rounded-gx-lg border border-dashed border-gx-border bg-gx-bg px-3 py-3 text-gx-12 text-gx-text-hint">
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

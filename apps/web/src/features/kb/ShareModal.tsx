// apps/web/src/features/kb/ShareModal.tsx
// 分享弹窗：只管【外部链接】——开关/复制/档位/级联分享下级。
//
// PERM-S5：原先还有一块「内部成员 仅可见/可编辑」，它写的是
// POST /api/kb/docs/:docId/share/internal —— 后端从未注册该子路由（apps/api/src/routes/kb/
// sharing.ts 只有 GET/POST /docs/:docId/share），点保存必 404。且它要落的 kb_doc_acls 在新
// 权限模型里已不参与放行（放行只读 role_library_scope：domain/authz/libraryPolicy.ts，
// kb 守卫 requireDocAccess 从不查 kbDocAcl），修成能写也只是「配了不生效」的死开关。
// 故整块下线：改成一条只读结论——组织内能否编辑由知识库角色配置决定，去权限管理改。

import { useEffect, useRef, useState } from "react";
import { Modal, Button, Switch, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useShareState, useSetShare } from "./kb-hooks";
import { withBase } from "../../api/client";
import { COPY_FAIL_HINT_LINK, copyText } from "../../lib/clipboard";
import { ShareDegradedNote, ShareModeField } from "../sharing/ShareModeField";
import { ShareForbiddenNote } from "../sharing/ShareForbiddenNote";
import { shareErrorMessage, shareForbiddenMessage } from "../sharing/share-hooks";

export function ShareModal({ docId, kbId, kind = "doc", open, onClose }: { docId: string; kbId: string; kind?: "doc" | "canvas"; open: boolean; onClose: () => void }) {
  const { data, isLoading, error } = useShareState(open ? docId : undefined);
  const setShare = useSetShare(docId, kbId);
  // GET /share 403（角色没被授予「可分享」且无库管理权）时 data 永远为空：
  // 不特判就会一直停在「加载中…」，看着像产品坏了，其实是你没资格。
  const forbidden = shareForbiddenMessage(error);

  const [enabled, setEnabled] = useState(false);
  const [linkRole, setLinkRole] = useState<"viewer" | "editor">("viewer");
  const [includeChildren, setIncludeChildren] = useState(false);
  // 复制失败时用于自动选中链接文本，让用户可直接按 Ctrl/⌘ + C。
  const linkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (data?.share) {
      setEnabled(data.share.shareEnabled);
      setLinkRole(data.share.shareRole);
      setIncludeChildren(data.share.shareIncludeChildren);
    }
  }, [data]);

  const share = data?.share;
  const canManage = share?.canManage ?? true;
  // 子路径部署（/app/gouxiangdb）下公开分享链接必须带网关前缀。
  const fullUrl = share?.shareToken ? `${window.location.origin}${withBase(`/s/${share.shareToken}`)}` : "";

  // 降级：申请了「可编辑」但分享人后来失去了编辑权 → 后端每次访问现算，链接已回落只读
  // （resolveDocShareCaps）。这里只显示结论，不重算权限。
  const degraded = share?.degraded === true;
  // 「可编辑」能不能开：以后端 GET 现算的 canGrantEdit 为准（canSharerGrantDocEdit，与 POST 时的
  // assertSharerCanGrantDocEdit 是同一次判定）——前端不自己推导"我大概能编辑"。
  // 字段缺失时（旧缓存/契约回退）退化为保守判定：申请过 edit 且已降级 → 本人确定失权，置灰。
  // 无论哪条路径，后端 POST 都会再判一次，403 原文由 updateLinkRole 原样 toast。
  const canGrantEdit = share?.canGrantEdit ?? !(share?.requestedMode === "edit" && degraded);

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

  return (
    <Modal open={open} onClose={onClose} title="分享" width={520} footer={<Button onClick={onClose}>完成</Button>}>
      {isLoading ? (
        <div className="py-10 text-center text-gx-13 text-gx-text-hint">加载中…</div>
      ) : forbidden ? (
        <ShareForbiddenNote message={forbidden} onClose={onClose} />
      ) : !share ? (
        <div className="py-10 text-center text-gx-13 text-gx-text-hint">加载中…</div>
      ) : (
        <div className="space-y-5">
          {/* ① 内部成员：只读结论，不提供写入口（PERM-S5）。
              组织内成员能否编辑由知识库角色配置决定（后端 GET 现算的 membersCanEdit），
              这里改动不了也不该改——此前那两个档位打的是不存在的
              POST /api/kb/docs/:docId/share/internal，点了必 404。 */}
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-gx-13 font-semibold text-gx-text-primary">
              <Icon name="users" size={15} className="text-gx-text-secondary" />
              内部成员
            </div>
            <div className="rounded-gx-lg border border-gx-separator bg-gx-bg px-2.5 py-2 text-gx-12 text-gx-text-secondary">
              组织内成员当前{data?.internal?.membersCanEdit ? "可编辑" : "仅可见"}本篇内容。
            </div>
            <p className="mt-1.5 text-gx-11 text-gx-text-hint">
              内部访问由知识库的角色配置决定，不在分享设置里调整；分享设置也不会降低成员已有权限。
            </p>
          </section>

          {/* ② 外部链接 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-gx-13 font-semibold text-gx-text-primary">
                <Icon name="globe" size={15} className="text-gx-text-secondary" />
                外部链接
              </div>
              {/* PERM-S3：无库管理权者不能点这个总闸——原先可点再靠后端 403 回滚，
                  属于「该禁用却可点」。置灰原因与内部成员档位同一来源（canManage）。 */}
              <Switch
                checked={enabled}
                onChange={toggleShare}
                disabled={!canManage || setShare.isPending}
                disabledReason="你对该知识库没有管理权，不能修改外链分享"
              />
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
                    editDesc="获得链接的人无需登录即可直接编辑正文，也能改文档里嵌入的数据表"
                    // 作用范围与生效边界必须写清楚，避免把「链接级档位」误当成系统内角色权限。
                    scopeNote="说明：「可编辑」只作用于这一条链接，不改变任何人在系统内的角色权限；分享人一旦失去编辑权，链接会自动回落为只读。"
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

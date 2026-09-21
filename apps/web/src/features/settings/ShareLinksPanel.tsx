// apps/web/src/features/settings/ShareLinksPanel.tsx
// 库级「分享链接」管理：生成 / 复制 / 关闭。
//
// 背景：上一个工单删掉了旧的 SharePanel（逐库逐人的名册下线时一并清理），但「分享」是产品
// 的一等公民——库设置里还有「允许分享」开关，却没有生成/复制/关闭链接的界面，功能等于残了。
// 本组件把那块界面补回来，只做一件事：管这个库的外发链接。
//
// 三条纪律：
//   1) 生成受「允许分享」开关控制：开关没开就不给生成按钮（不是给个灰按钮），并写明原因，
//      否则管理员会一直找那个点不动的按钮。开关本体在同页的 LibraryAccessPanel 里。
//   2) 外发一律只读：后端 public.ts 已关掉匿名写，链接点进来的人只能看。界面不提供
//      「可编辑」档位（选了也不生效），并用文案说清这一点。
//   3) fail-closed：分享设置没读回来 / 出错，一律按「不能生成」渲染。

import { useState } from "react";
import { Button, EmptyState, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { confirmAction } from "../../components/feedback";
import { useGXMutations, useLibraryAccess, useShareLinks } from "../../api/hooks";
import { withBase } from "../../api/client";
import { COPY_FAIL_HINT_LINK, copyText } from "../../lib/clipboard";
import { SHARE_READONLY_HINT } from "./role-permission/labels";

function fmtTime(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString("zh-CN", { hour12: false });
}

export function ShareLinksPanel({ baseId, canManageBase }: { baseId: string; canManageBase: boolean }) {
  const access = useLibraryAccess("base", baseId);
  const { data: links } = useShareLinks(baseId);
  const m = useGXMutations();
  const [busy, setBusy] = useState(false);

  // 只有对本库有管理权的人能管链接（后端 requireCanManageBase 同步门控 403）。
  // 分享设置读回来之前一律按「未知」处理（fail-closed）。
  const loaded = !access.isLoading && !access.isError && !!access.data;
  const shareEnabled = access.data?.shareEnabled ?? false;

  async function copyLink(url: string) {
    // 子路径部署（/app/gouxiangdb）下链接必须带网关前缀，否则命中后端根 404。
    const full = `${window.location.origin}${withBase(url)}`;
    if (await copyText(full)) {
      toast("链接已复制", "success");
      return;
    }
    toast(COPY_FAIL_HINT_LINK, "error");
  }

  async function create() {
    setBusy(true);
    try {
      // 外发恒只读：只生成 viewer 链接（后端已关匿名写，editor/commenter 档位没有意义）。
      await m.createShareLink.mutateAsync({ baseId, role: "viewer" });
      toast("已生成分享链接", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "生成失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function close(linkId: string, url: string) {
    const ok = await confirmAction({
      title: "关闭分享链接",
      confirmText: "关闭链接",
      cancelText: "取消",
      level: 2,
      description: `链接「${url}」会立即失效，正在使用它的人将失去访问。需要时可以再生成一条。`,
    });
    if (!ok) return;
    try {
      await m.removeShareLink.mutateAsync({ baseId, linkId });
      toast("已关闭链接", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "关闭失败", "error");
    }
  }

  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-surface p-4">
      <div className="flex items-start gap-3">
        <Icon name="share" size={20} className="mt-0.5 shrink-0 text-gx-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-gx-14 font-medium text-gx-text-primary">分享链接</div>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">{SHARE_READONLY_HINT}</p>
        </div>
        {canManageBase && loaded && shareEnabled && (
          <Button variant="primary" icon="plus" loading={busy} onClick={() => void create()}>
            生成分享链接
          </Button>
        )}
      </div>

      {!canManageBase && (
        <div className="mt-3 flex items-start gap-1.5 text-gx-12 text-gx-text-tertiary">
          <Icon name="lock" size={13} className="mt-0.5 shrink-0" />
          <span>只有对本库有管理权限的角色、超级管理员与管理员，才能生成或关闭分享链接。</span>
        </div>
      )}

      {canManageBase && access.isLoading && (
        <div className="mt-3 text-gx-12 text-gx-text-hint">正在读取这个库的分享设置…</div>
      )}

      {canManageBase && access.isError && (
        <div className="mt-3 flex items-start gap-1.5 text-gx-12 text-gx-text-tertiary">
          <Icon name="alertCircle" size={13} className="mt-0.5 shrink-0" />
          <span>分享设置读取失败，暂时无法生成分享链接。</span>
        </div>
      )}

      {/* 开关没开：不给灰按钮，直接说明原因与先去哪里开。 */}
      {canManageBase && loaded && !shareEnabled && (
        <div className="mt-3 rounded-gx-lg border border-dashed border-gx-border bg-gx-bg px-3 py-3 text-gx-12 text-gx-text-hint">
          这个库还没打开「允许分享」，所以现在不能生成分享链接。请先在上方「谁能访问这个库」里打开「允许把这个库的内容分享出去」，再回到这里生成。
        </div>
      )}

      {canManageBase && loaded && shareEnabled && (
        <div className="mt-3 overflow-hidden rounded-gx-lg border border-gx-border">
          {(links ?? []).map((l) => {
            const full = `${window.location.origin}${withBase(l.url)}`;
            return (
              <div key={l.id} className="flex items-center gap-3 border-b border-gx-separator px-3 py-2 last:border-0">
                <button
                  type="button"
                  onClick={() => void copyLink(l.url)}
                  title="点击复制链接"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-gx-13 text-gx-accent hover:underline"
                >
                  <Icon name="link" size={13} className="shrink-0" />
                  <span className="truncate">{full}</span>
                </button>
                <span className="w-36 shrink-0 text-gx-12 text-gx-text-tertiary">{fmtTime(l.createdAt)}</span>
                <span className="shrink-0 text-gx-11 text-gx-text-hint">外部人只读</span>
                <Button size="sm" variant="secondary" icon="copy" onClick={() => void copyLink(l.url)}>
                  复制
                </Button>
                <Button size="sm" variant="ghost" className="text-gx-danger" onClick={() => void close(l.id, full)}>
                  关闭
                </Button>
              </div>
            );
          })}
          {(!links || links.length === 0) && (
            <EmptyState
              icon="link"
              title="还没有分享链接"
              description="点右上角「生成分享链接」，把链接发给组织外的人，他们无需登录即可查看，但不能修改。"
            />
          )}
        </div>
      )}
    </div>
  );
}

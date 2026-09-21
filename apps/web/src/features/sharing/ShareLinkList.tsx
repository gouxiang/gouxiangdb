// apps/web/src/features/sharing/ShareLinkList.tsx
// 分享链接列表：URL（点击即复制）/ 创建时间 / **生效档位** / 降级提示 / 关闭。
//
// 口径：档位一律显示 effectiveMode（本次访问实际生效的档位），不显示 mode（创建时申请的档位）。
// 两条链接可以都是 mode=edit，但其中一条因为分享人被降权已经只读——只显示 mode 会让人以为
// 它们还能写。degraded=true 的那条必须把「已自动变为只读」说出来。

import type { ObjectShareLinkDTO } from "@gx/shared-types";
import { Button, EmptyState } from "../../components/ui";
import { Icon } from "../../components/icons";
import { withBase } from "../../api/client";
import { ShareDegradedNote } from "./ShareModeField";

/** 完整可访问 URL（子路径部署补网关前缀）。SSR/单测无 window 时退化为同源路径本身。 */
export function shareUrlOf(url: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}${withBase(url)}`;
}

export function fmtTime(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString("zh-CN", { hour12: false });
}

export interface ShareLinkListProps {
  links: ObjectShareLinkDTO[];
  /** 点击 URL 即复制（调用方走 copyText 三级降级） */
  onCopy: (link: ObjectShareLinkDTO) => void;
  /** 关闭（调用方负责 confirm 二次确认） */
  onRevoke: (link: ObjectShareLinkDTO) => void;
  /** 正在关闭的链接 id（按钮转圈，防连点） */
  busyId?: string | null;
  emptyDescription?: string;
}

export function ShareLinkList({
  links,
  onCopy,
  onRevoke,
  busyId = null,
  emptyDescription = "选好档位后点「生成链接」，把链接发给组织外的人，他们无需登录即可访问。",
}: ShareLinkListProps) {
  if (links.length === 0) {
    return <EmptyState icon="link" title="还没有分享链接" description={emptyDescription} />;
  }
  return (
    <div className="overflow-hidden rounded-gx-lg border border-gx-border">
      {links.map((l) => (
        <LinkRow
          key={l.id}
          link={l}
          busy={busyId === l.id}
          onCopy={() => onCopy(l)}
          onRevoke={() => onRevoke(l)}
        />
      ))}
    </div>
  );
}

function LinkRow({
  link,
  busy,
  onCopy,
  onRevoke,
}: {
  link: ObjectShareLinkDTO;
  busy: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const full = shareUrlOf(link.url);
  return (
    <div className="border-b border-gx-separator px-3 py-2 last:border-0">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onCopy}
          title="点击复制链接"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-gx-13 text-gx-accent hover:underline"
        >
          <Icon name="link" size={13} className="shrink-0" />
          <span className="truncate">{full}</span>
        </button>
        <span className="w-36 shrink-0 text-gx-12 text-gx-text-tertiary">{fmtTime(link.createdAt)}</span>
        {/* 生效档位：以 effectiveMode 为准，不是 mode */}
        <span className="shrink-0 text-gx-11 text-gx-text-hint">
          {link.effectiveMode === "edit" ? "生效：可编辑" : "生效：只读"}
        </span>
        <Button size="sm" variant="secondary" icon="copy" onClick={onCopy}>
          复制
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-gx-danger"
          loading={busy}
          onClick={onRevoke}
        >
          关闭
        </Button>
      </div>
      {/* 申请了可编辑、但分享人已被降权：这条链接现在实际是只读 */}
      {link.degraded ? <ShareDegradedNote /> : null}
    </div>
  );
}

// apps/web/src/features/kb/kb-ui.tsx
// 知识库共享小件：类型图标、角色文案、时间格式化。全部走 gx-* token 与自建 SVG 图标。

import { Icon, type IconName } from "../../components/icons";
import type { KbDocKind } from "../../api/client";
import { colors } from "@gx/design-tokens";

/** 文档/画布类型图标（不用 emoji） */
export function DocKindIcon({ kind, size = 15, className }: { kind: KbDocKind; size?: number; className?: string }) {
  const name: IconName = kind === "canvas" ? "canvas" : "doc";
  const color = kind === "canvas" ? colors.secondaryAlt : colors.accent;
  return <Icon name={name} size={size} className={className} style={{ color }} />;
}

export const KB_ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  editor: "可编辑",
  commenter: "可评论",
  viewer: "仅查看",
};

export const KB_ROLE_RANK: Record<string, number> = {
  owner: 4,
  editor: 3,
  commenter: 2,
  viewer: 1,
};

export function roleLabel(role?: string | null): string {
  if (!role) return "—";
  return KB_ROLE_LABEL[role] ?? role;
}

export function formatTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 画布内容 JSON 是否为空（无任何元素） */
export function isCanvasEmpty(content?: string): boolean {
  if (!content || !content.trim()) return true;
  try {
    const v = JSON.parse(content);
    return !Array.isArray(v) || v.length === 0;
  } catch {
    return true;
  }
}

/**
 * 文档/画布访问异常态（无权限 / 已删除 / 不存在 / 加载失败）。
 * status 来自 ApiError.status：403/401 → 无权限；404 → 已删除或不存在；其余 → 加载失败可重试。
 * 用于 @引用跳转后的目标页与编辑器加载守卫，避免 doc 为 undefined 时白屏崩溃。
 */
export function DocAccessError({
  status,
  kind = "doc",
  onBack,
  onRetry,
}: {
  status?: number;
  kind?: KbDocKind;
  onBack: () => void;
  onRetry?: () => void;
}) {
  const isForbidden = status === 403 || status === 401;
  const isNotFound = status === 404;
  const title = isForbidden
    ? "没有访问权限"
    : isNotFound
      ? `${kind === "canvas" ? "画布" : "文档"}不存在或已被删除`
      : "内容加载失败";
  const desc = isForbidden
    ? "你当前无权查看该内容，可联系所有者开通权限后重试。"
    : isNotFound
      ? `该${kind === "canvas" ? "画布" : "文档"}可能已被作者删除，或引用链接已失效。`
      : "网络异常或服务暂时不可用，请稍后重试。";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-gx-bg px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gx-surface">
        <Icon name={isForbidden ? "lock" : isNotFound ? "doc" : "alertCircle"} size={24} className="text-gx-text-hint" />
      </div>
      <div className="text-gx-15 font-semibold text-gx-text-primary">{title}</div>
      <div className="max-w-sm text-gx-13 leading-relaxed text-gx-text-hint">{desc}</div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 items-center gap-1.5 rounded-gx-md border border-gx-border bg-gx-surface px-3 text-gx-12 text-gx-text-secondary hover:bg-gx-bg"
        >
          <Icon name="chevronLeft" size={14} />
          返回
        </button>
        {onRetry && !isForbidden && !isNotFound && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center gap-1.5 rounded-gx-md bg-gx-accent px-3 text-gx-12 font-medium text-white hover:brightness-95"
          >
            <Icon name="refresh" size={14} />
            重试
          </button>
        )}
      </div>
    </div>
  );
}


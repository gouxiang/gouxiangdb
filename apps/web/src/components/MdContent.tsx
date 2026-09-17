// apps/web/src/components/MdContent.tsx
// 通用 Markdown 渲染容器：
//   - variant="inline"：仅行内格式（粗/斜/删/码/高亮/链接/上标下标），单行截断，用于表格单元格
//   - variant="block"：完整块级渲染（标题/列表/表格/媒体/组件），用于记录详情、弹窗
// 内部链接（/kb、/base 开头）走 SPA 路由跳转；外部链接新窗口打开。

import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { renderMarkdown } from "@gx/blocks";
import { inlineMdToHtml } from "@gx/blocks";
import { makeLinkClickHandler } from "../lib/internal-links";

export function MdContent({
  md,
  variant = "inline",
  className,
  onClick,
}: {
  md: string;
  variant?: "inline" | "block";
  className?: string;
  /** 外层点击（如单元格点击打开记录）；内部链接点击会 stopPropagation 后单独导航 */
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const navigate = useNavigate();
  const onLinkClick = useCallback(makeLinkClickHandler((p) => navigate(p)), [navigate]);

  // 渲染失败降级为纯文本（脏数据/异常块结构不应炸掉整页或整行）
  let html = "";
  let ok = true;
  try {
    html = variant === "block" ? renderMarkdown(md ?? "") : inlineMdToHtml(md ?? "");
  } catch {
    ok = false;
    html = escapeForText(md ?? "");
  }

  return (
    <div
      className={className}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement | null)?.closest?.("a");
        if (anchor) {
          e.stopPropagation();
          onLinkClick(e);
          return;
        }
        onClick?.(e);
      }}
      {...(ok
        ? { dangerouslySetInnerHTML: { __html: html } }
        : { children: html })}
    />
  );
}

function escapeForText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

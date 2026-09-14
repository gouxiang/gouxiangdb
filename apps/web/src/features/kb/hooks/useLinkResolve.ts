// apps/web/src/features/kb/hooks/useLinkResolve.ts
// @ 引用 / md-link 点击前的链接可达性探测：
//   解析 /kb/:kbId/(doc|canvas)/:docId 形式为内部链接，
//   通过 ACL 接口（HEAD）确认 ok / deleted / forbidden / network。
//   设计要点：
//   - 仅探测 internal 链接；http(s) 视为 always-ok（外链不该被本项目权限管控）
//   - 探测结果缓存 60s（按 href 维度），避免 hover 抖动刷请求
//   - 不阻塞点击：探测异步进行，结果回传后再决定是否 navigate
//   - 失败不抛错；上层拿到 LinkResolveResult 自取 ok/toast

import { useCallback, useMemo } from "react";
import { useAuthStore } from "../../../store/auth";
import { withBase } from "../../../api/client";

export type LinkResolveKind = "ok" | "deleted" | "forbidden" | "network" | "external" | "unknown";

export interface LinkResolveResult {
  ok: boolean;
  kind: LinkResolveKind;
  href: string;
  /** 用户可见提示文案（toast），undefined 表示无提示 */
  toast?: string;
}

const INTERNAL_RE = /^\/kb\/([^/]+)\/(doc|canvas)\/([^/?#]+)/;

function probePath(href: string): { kbId: string; kind: "doc" | "canvas"; docId: string } | null {
  const m = INTERNAL_RE.exec(href);
  if (!m) return null;
  return { kbId: m[1]!, kind: m[2]! as "doc" | "canvas", docId: m[3]! };
}

interface CacheEntry {
  expires: number;
  result: LinkResolveResult;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export function useLinkResolve() {
  // 让 hook 订阅 token（token 变更后清缓存，避免用旧凭据探测）
  const token = useAuthStore((s) => s.token);
  useMemo(() => {
    if (!token) cache.clear();
  }, [token]);

  return useCallback(async (href: string): Promise<LinkResolveResult> => {
    const probe = probePath(href);
    if (!probe) {
      // http(s) 视为 always-ok
      return { ok: true, kind: "external", href };
    }

    // 缓存命中
    const cached = cache.get(href);
    if (cached && cached.expires > Date.now()) {
      return cached.result;
    }

    const result: LinkResolveResult = await new Promise((resolve) => {
      const auth = useAuthStore.getState();
      const tok = auth.token;
      if (!tok) {
        resolve({ ok: false, kind: "unknown", href, toast: "请先登录" });
        return;
      }
      // 用 ACL 端点 GET 探测可达性（不读 body，HEAD 不可靠）。
      // 后端路由是 /api/kb/docs/:docId/acl（kbId 隐含在 docId 反查），
      // 返回 200=可访问 / 404=已删除 / 403=无权限 / 401=未登录。
      // 不显式传 kbId：链接里的 kbId 可能因分享/复制产生漂移，以 docId 单维度探测更稳。
      void probe.kbId;
      fetch(withBase(`/api/kb/docs/${probe.docId}/acl`), {
        method: "GET",
        headers: { Authorization: `Bearer ${tok}` },
      })
        .then(async (r) => {
          if (r.status === 200) {
            resolve({ ok: true, kind: "ok", href });
          } else if (r.status === 404) {
            resolve({ ok: false, kind: "deleted", href, toast: "该文档已删除" });
          } else if (r.status === 403) {
            resolve({ ok: false, kind: "forbidden", href, toast: "您没有访问权限" });
          } else {
            resolve({ ok: false, kind: "unknown", href, toast: "链接不可用" });
          }
        })
        .catch(() => {
          resolve({ ok: false, kind: "network", href, toast: "网络错误，请稍后重试" });
        });
    });

    cache.set(href, { expires: Date.now() + TTL_MS, result });
    return result;
    // 引入 useKbCache 是为了让编辑态被识别为合法成员；若用 useDoc 会拉整文档内容，过重
  }, []);
}

/** 清空所有缓存（用于测试 / 主动失效） */
export function clearLinkResolveCache() {
  cache.clear();
}
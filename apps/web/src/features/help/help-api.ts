// apps/web/src/features/help/help-api.ts
// 帮助百科在线拉取：GET /api/help/wiki?page=<标题>（后端同源代理 Gitea wiki）。
//
// 纪律：不裸 fetch、不引第三方——统一复用 api/client.ts 的 apiFetch（同源前缀解析、
// 数据源/鉴权头注入、ApiError 信封都在那里）。本模块只放帮助中心自己的类型与一个轻量 GET。
//
// 成功：{ ok, page, home, markdown, imageBase, pages, updatedAt? }
// 失败：后端 502 { ok:false, code:"WIKI_UNREACHABLE" }（百科不可达/离线），网络异常由
// apiFetch 透传；调用方统一降级为中文友好提示。

import { apiFetch } from "../../api/client";
import type { WikiPageEntry } from "./help-html";

export interface HelpWikiResponse {
  ok: true;
  page: string;
  home: string;
  markdown: string;
  /** 后端已改写图片用的同源前缀；前端不再改写图片路径，仅留档。 */
  imageBase: string;
  pages: WikiPageEntry[];
  updatedAt?: string;
}

/** 后端 502 结构化信封（百科服务器不可达/离线）。 */
export const WIKI_UNREACHABLE = "WIKI_UNREACHABLE";

function qsPage(page: string): string {
  return page && page !== "Home" ? `?page=${encodeURIComponent(page)}` : "";
}

/** 拉取指定百科页（缺省 Home）。502 WIKI_UNREACHABLE / 网络错误由调用方降级处理。 */
export function fetchHelpWiki(page = "Home"): Promise<HelpWikiResponse> {
  return apiFetch<HelpWikiResponse>(`/api/help/wiki${qsPage(page)}`);
}

// apps/web/src/features/kb/publicDocSave.ts
// 公开分享页正文保存的**纯逻辑**（无 React、无副作用），供页面与单测共用。
//
// 为什么单独抽出来：这是「防互相冲掉内容」的核心——乐观锁 + 409 处理必须能被单测
// 精确锁住（apps/web 无 jsdom，页面级交互难以在 node 环境触发）。这里只负责「发一次
// 请求、把结果翻译成结果对象」，把「刷新编辑器内容 / 弹提示」交给调用方。
//
// 硬约束（对应后端契约 apps/api/src/routes/publicDoc.ts + domain/share/externalDoc.ts）：
//   - PUT 成功 → 200 { ok, updatedAt, canEdit, mode }，用返回 updatedAt 作为新基线；
//   - 版本冲突 → 409 { code:"CONFLICT", content, updatedAt }，**绝不覆盖他人改动**：
//     返回最新 content 让调用方就地刷新，且**本次不再自动重发保存**；
//   - 档位不足 → 403（分享人被降权后链接回落只读）；
//   - 其它 → 失败原因原样回传（保留用户本地内容，不丢改动）。

import { ApiError } from "../../api/client";

/** 保存成功（R-D-21：只说结果）。 */
export const PUBLIC_DOC_SAVE_OK = "已保存到云端";
/** 409：他人已改，就地刷新为最新 —— 必须让用户知道「你这次保存没生效」。 */
export const PUBLIC_DOC_CONFLICT_MSG = "内容已被其他人修改，已为你刷新为最新版本，请重新编辑你的改动";
/** 409 但响应体没带最新内容（不应发生）：不做原地覆盖，提示刷新。 */
export const PUBLIC_DOC_CONFLICT_EMPTY_MSG = "内容已被其他人修改，请刷新页面后再编辑";
/** 403：档位不足。 */
export const PUBLIC_DOC_FORBIDDEN_MSG = "分享链接已变为只读，你的改动未保存";
/** 兜底失败文案。 */
export const PUBLIC_DOC_SAVE_FAILED_MSG = "保存失败，请稍后重试";

export type PublicDocSaveStatus = "saved" | "conflict" | "forbidden" | "error";

export interface PublicDocSaveOutcome {
  status: PublicDocSaveStatus;
  /** saved：新基线；conflict：库中最新基线（刷新后的新 baseUpdatedAt）。 */
  updatedAt?: string;
  /** conflict：库中最新正文，调用方据此**替换编辑器内容**。 */
  content?: string;
  /** 直接可展示给用户的文案。 */
  message: string;
}

/**
 * 执行一次正文保存（乐观锁）。
 * **只发一次请求，绝不自动重试/重发**：409 时把库中最新内容交回调用方去替换编辑器，
 * 由用户重新编辑后再次手动保存。
 */
export async function performPublicDocSave(
  save: (args: { content: string; baseUpdatedAt: string }) => Promise<{ updatedAt: string }>,
  args: { content: string; baseUpdatedAt: string },
): Promise<PublicDocSaveOutcome> {
  try {
    const res = await save(args);
    return { status: "saved", updatedAt: res.updatedAt, message: PUBLIC_DOC_SAVE_OK };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const content = typeof e.body?.content === "string" ? e.body.content : null;
      const updatedAt = typeof e.body?.updatedAt === "string" ? e.body.updatedAt : null;
      // 只有同时拿到最新内容与基线，才敢「就地刷新」——否则宁可不改本地状态，
      // 避免基线被推进后下一次保存把别人的改动冲掉。
      if (content !== null && updatedAt !== null) {
        return { status: "conflict", content, updatedAt, message: PUBLIC_DOC_CONFLICT_MSG };
      }
      return { status: "error", message: PUBLIC_DOC_CONFLICT_EMPTY_MSG };
    }
    if (e instanceof ApiError && e.status === 403) {
      return { status: "forbidden", message: PUBLIC_DOC_FORBIDDEN_MSG };
    }
    const detail =
      e instanceof ApiError ? e.body?.error : e instanceof Error ? e.message : undefined;
    return { status: "error", message: detail || PUBLIC_DOC_SAVE_FAILED_MSG };
  }
}

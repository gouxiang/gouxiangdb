// apps/web/src/features/kb/publicDocSave.test.ts
// 公开分享页正文保存的**核心 409 处理**必须锁死：不得吞掉、不得重发覆盖。
// 纯函数，node 环境直接跑（apps/web 无 jsdom）。

import { describe, it, expect, vi } from "vitest";
import { ApiError } from "../../api/client";
import {
  performPublicDocSave,
  PUBLIC_DOC_SAVE_OK,
  PUBLIC_DOC_CONFLICT_MSG,
  PUBLIC_DOC_CONFLICT_EMPTY_MSG,
  PUBLIC_DOC_FORBIDDEN_MSG,
} from "./publicDocSave";

const args = { content: "本地改动", baseUpdatedAt: "2026-01-01T00:00:00.000Z" };

describe("publicDocSave：成功路径", () => {
  it("带上 content + baseUpdatedAt，成功后回传新基线", async () => {
    const save = vi.fn().mockResolvedValue({ updatedAt: "2026-01-02T00:00:00.000Z" });
    const out = await performPublicDocSave(save, args);
    expect(save).toHaveBeenCalledTimes(1);
    // 乐观锁：必须把加载/上次保存拿到的基线原样带回去
    expect(save).toHaveBeenCalledWith({ content: "本地改动", baseUpdatedAt: "2026-01-01T00:00:00.000Z" });
    expect(out.status).toBe("saved");
    expect(out.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(out.message).toBe(PUBLIC_DOC_SAVE_OK);
  });
});

describe("publicDocSave：409 冲突（防互相冲掉内容的核心）", () => {
  const conflict = new ApiError(409, {
    error: "内容已被其他人修改，请刷新后再编辑",
    code: "CONFLICT",
    content: "服务端最新正文",
    updatedAt: "2026-01-03T00:00:00.000Z",
  });

  it("把服务端最新 content 交回调用方（用于替换编辑器）并推进基线", async () => {
    const save = vi.fn().mockRejectedValue(conflict);
    const out = await performPublicDocSave(save, args);
    expect(out.status).toBe("conflict");
    expect(out.content).toBe("服务端最新正文");
    expect(out.updatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(out.message).toBe(PUBLIC_DOC_CONFLICT_MSG);
  });

  it("**只发一次请求，绝不自动重发保存**", async () => {
    const save = vi.fn().mockRejectedValue(conflict);
    await performPublicDocSave(save, args);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("提示文案明确告知「已刷新为最新、请重新编辑你的改动」", () => {
    expect(PUBLIC_DOC_CONFLICT_MSG).toContain("已被其他人修改");
    expect(PUBLIC_DOC_CONFLICT_MSG).toContain("刷新为最新版本");
    expect(PUBLIC_DOC_CONFLICT_MSG).toContain("重新编辑");
  });

  it("409 但响应体没带最新内容 → 不就地覆盖（降级为 error，避免基线被推进后冲掉别人改动）", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError(409, { error: "冲突", code: "CONFLICT" }));
    const out = await performPublicDocSave(save, args);
    expect(out.status).toBe("error");
    expect(out.content).toBeUndefined();
    expect(out.updatedAt).toBeUndefined();
    expect(out.message).toBe(PUBLIC_DOC_CONFLICT_EMPTY_MSG);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("publicDocSave：其它失败分支", () => {
  it("403（档位不足 / 链接已回落只读）→ forbidden，不重发", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError(403, { error: "只读", code: "FORBIDDEN" }));
    const out = await performPublicDocSave(save, args);
    expect(out.status).toBe("forbidden");
    expect(out.message).toBe(PUBLIC_DOC_FORBIDDEN_MSG);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("400 / 其它错误 → error，带后端原因，保留调用方本地内容（不重发）", async () => {
    const save = vi.fn().mockRejectedValue(new ApiError(400, { error: "缺少 baseUpdatedAt", code: "BAD_REQUEST" }));
    const out = await performPublicDocSave(save, args);
    expect(out.status).toBe("error");
    expect(out.message).toBe("缺少 baseUpdatedAt");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("非 ApiError 的异常也兜住，不抛给调用方", async () => {
    const save = vi.fn().mockRejectedValue(new Error("网络中断"));
    const out = await performPublicDocSave(save, args);
    expect(out.status).toBe("error");
    expect(out.message).toBe("网络中断");
  });
});

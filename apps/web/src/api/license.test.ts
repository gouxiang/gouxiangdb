// 授权数据层单测：错误判定纯函数、附件代理地址拼接、multipart 提交行为、poll 响应宽容归一。
// 纯 node，stub global.fetch（范式同 api/localSync.test.ts）。
import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from "vitest";
import { ApiError } from "./client";
import {
  LicenseApi,
  isLicenseAdminOnly,
  isLicenseDisabled,
  licenseErrorCode,
  normalizePollResponse,
} from "./license";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("licenseErrorCode / isLicenseDisabled", () => {
  it("从 ApiError.body.code 取机器码", () => {
    const e = new ApiError(403, { code: "LICENSE_SEAT_SUSPENDED", error: "x" });
    expect(licenseErrorCode(e)).toBe("LICENSE_SEAT_SUSPENDED");
  });

  it("无 code / 非对象 body / 非 ApiError 返回 null", () => {
    expect(licenseErrorCode(new ApiError(500, {}))).toBeNull();
    expect(licenseErrorCode(new Error("boom"))).toBeNull();
    expect(licenseErrorCode(null)).toBeNull();
  });

  it("404 判定为授权服务未启用，403/500 不是", () => {
    expect(isLicenseDisabled(new ApiError(404, { code: "LICENSE_DISABLED" }))).toBe(true);
    expect(isLicenseDisabled(new ApiError(403, { code: "LICENSE_ADMIN_ONLY" }))).toBe(false);
  });

  it("LICENSE_ADMIN_ONLY 判定", () => {
    expect(isLicenseAdminOnly(new ApiError(403, { code: "LICENSE_ADMIN_ONLY" }))).toBe(true);
    expect(isLicenseAdminOnly(new ApiError(403, { code: "OTHER" }))).toBe(false);
  });
});

describe("attachmentUrl", () => {
  it("拼同源代理地址并对 path 做编码", () => {
    const url = LicenseApi.attachmentUrl("/v1/feedback/attachment/a b_1.png");
    expect(url).toBe(
      "/api/license/feedback/attachment?path=" + encodeURIComponent("/v1/feedback/attachment/a b_1.png"),
    );
  });
});

describe("submitFeedback（multipart）", () => {
  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ ok: true, ticketId: "t_1" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("以 multipart 提交且不手动设置 Content-Type（浏览器自带 boundary）", async () => {
    const f = new File(["hello"], "a.txt", { type: "text/plain" });
    const res = await LicenseApi.submitFeedback({
      content: "问题描述",
      category: "tech",
      contactEmail: "u@example.com",
      files: [f],
    });
    expect(res.ok).toBe(true);
    expect(res.ticketId).toBe("t_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/license/feedback");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get("content")).toBe("问题描述");
    expect(fd.get("category")).toBe("tech");
    expect(fd.get("contactEmail")).toBe("u@example.com");
    // 关键：headers 里绝不能出现 Content-Type（否则缺 boundary，后端解析失败）
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
  });

  it("后端 4xx 抛 ApiError（携带 code）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "不支持的附件类型", code: "FEEDBACK_BAD_FILE_TYPE" }, 400),
    );
    await expect(
      LicenseApi.submitFeedback({ content: "x", files: [] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("normalizePollResponse 宽容归一", () => {
  it("标准 {tickets:[...]} 形状", () => {
    const view = normalizePollResponse({
      tickets: [
        {
          id: "t1",
          subject: "账单疑问",
          content: "为什么扣费",
          category: "billing",
          status: "open",
          createdAt: 1760000000,
          replies: [
            { id: "r1", staff: true, content: "已处理", attachments: [{ id: "att1", name: "p.png" }] },
          ],
        },
      ],
      serverTime: 1760000000000,
    });
    expect(view.tickets).toHaveLength(1);
    const t = view.tickets[0]!;
    expect(t.id).toBe("t1");
    expect(t.category).toBe("billing");
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]!.staff).toBe(true);
    // 附件 id 兜底拼出代理 path
    expect(t.messages[0]!.attachments[0]!.path).toBe("/v1/feedback/attachment/att1");
    // epoch 秒 → 毫秒
    expect(t.createdAtMs).toBe(1760000000000);
  });

  it("裸数组 / data 包裹 / 字段缺失都不崩，空内容降级为空态", () => {
    const v1 = normalizePollResponse([{ ticketId: "x", title: "T", status: "resolved" }]);
    expect(v1.tickets[0]!.id).toBe("x");
    expect(v1.tickets[0]!.subject).toBe("T");

    const v2 = normalizePollResponse({ data: { tickets: [] } });
    expect(v2.tickets).toEqual([]);

    const v3 = normalizePollResponse(null);
    expect(v3.tickets).toEqual([]);

    const v4 = normalizePollResponse({ tickets: [{ unreadCount: 2 }] });
    expect(v4.tickets[0]!.unread).toBe(true);
    expect(v4.tickets[0]!.status).toBe("open");
  });

  it("无消息数组时用工单自身内容合成一条用户消息", () => {
    const view = normalizePollResponse({ tickets: [{ id: "t", content: "我提的问题" }] });
    expect(view.tickets[0]!.messages).toHaveLength(1);
    expect(view.tickets[0]!.messages[0]!.content).toBe("我提的问题");
    expect(view.tickets[0]!.messages[0]!.staff).toBe(false);
  });
});

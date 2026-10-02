// apps/web/src/features/attachments/api.test.ts
// 上传失败文案的两个纯函数单测（node 环境，无 jsdom，不碰 XHR/DOM）。
//
// 为什么值得测：飞牛 fnOS 上附件请求要先过门户、再经 index.cgi 的 curl 反代，
// 大包很可能被宿主层（nginx / 门户）拦下并回一段 HTML——响应体解析不出 JSON 时，
// 用户看到的就是 uploadHttpFallback 的返回值。这段文案必须把「机器码」翻成「人话」，
// 否则「上传失败（HTTP 413）」对产品负责人等于没有信息。

import { describe, expect, it } from "vitest";
import { pickUploadError, uploadHttpFallback } from "./api";

describe("uploadHttpFallback：宿主层拦截码翻成人话", () => {
  it("413 说明是被设备/网络的上传限制拦的，不是后端拒绝", () => {
    const text = uploadHttpFallback(413);
    expect(text).toContain("413");
    expect(text).toContain("过大");
    // 必须给动作，不能只报码
    expect(text).toContain("压缩");
  });

  it("502 指向应用未响应并给出重启动作", () => {
    expect(uploadHttpFallback(502)).toContain("重启");
  });

  it("504 指向超时", () => {
    expect(uploadHttpFallback(504)).toContain("超时");
  });

  it("403 指向权限而非文件问题", () => {
    expect(uploadHttpFallback(403)).toContain("权限");
  });

  it("未知码仍保留原始状态码，不吞掉信息", () => {
    expect(uploadHttpFallback(500)).toBe("上传失败（HTTP 500）");
  });
});

describe("pickUploadError：服务端中文文案优先", () => {
  it("服务端给了 error 就用服务端的，不用机器码兜底", () => {
    expect(pickUploadError({ error: "不支持的文件格式：a.exe" }, "上传失败（HTTP 400）")).toBe(
      "不支持的文件格式：a.exe",
    );
  });

  it("响应不是 JSON（宿主 HTML 拦截页）时回落到人话兜底", () => {
    expect(pickUploadError(null, uploadHttpFallback(413))).toContain("过大");
  });

  it("服务端文案后补 code 对应的动作提示，不覆盖原文案", () => {
    const out = pickUploadError({ error: "文件过大" , code: "ATTACHMENT_TOO_LARGE" }, "x");
    expect(out.startsWith("文件过大")).toBe(true);
  });
});

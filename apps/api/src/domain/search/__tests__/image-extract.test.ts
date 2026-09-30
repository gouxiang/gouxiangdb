import { describe, expect, it } from "vitest";
import {
  extractAttachmentImages,
  extractMarkdownImages,
} from "../image-extract.js";

const PNG = "data:image/png;base64,AA";
const JPG = "data:image/jpeg;base64,BB";

describe("extractAttachmentImages", () => {
  it("提取附件 url 并去重", () => {
    const value = [
      { url: PNG, name: "a.png" },
      { url: PNG, name: "b.png" },
      { url: "https://h/x.jpg", name: "c.jpg" },
      { url: "foo", name: "d" },
      { name: "nourl" },
      null,
    ];
    expect(extractAttachmentImages(value)).toEqual([PNG, "https://h/x.jpg"]);
  });

  it("非数组 -> []", () => {
    expect(extractAttachmentImages(PNG)).toEqual([]);
    expect(extractAttachmentImages(null)).toEqual([]);
  });
});

describe("extractMarkdownImages", () => {
  it("提取 markdown 图片 URL 并去重", () => {
    const md = `
# 标题
图1 ![a](${JPG})
图2 ![b](${JPG})
链接 [x](https://h/page) 不应命中
图3 ![c](https://h/pic.png)
坏图 ![d](foo)
`;
    expect(extractMarkdownImages(md)).toEqual([JPG, "https://h/pic.png"]);
  });

  it("无图片 -> []", () => {
    expect(extractMarkdownImages("# 纯文本")).toEqual([]);
  });
});

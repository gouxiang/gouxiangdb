import { describe, expect, it } from "vitest";
import {
  buildMultimodalEndpoint,
  isUsableImageUrl,
  parseMultimodalEmbedding,
  toMultimodalInputParts,
} from "../embeddingMultimodal.js";

describe("buildMultimodalEndpoint", () => {
  it("版本段保留并拼 multimodal", () => {
    expect(buildMultimodalEndpoint("https://h/api/v3")).toBe(
      "https://h/api/v3/embeddings/multimodal",
    );
    expect(buildMultimodalEndpoint("https://h/v1/")).toBe(
      "https://h/v1/embeddings/multimodal",
    );
  });

  it("无版本段补 v1", () => {
    expect(buildMultimodalEndpoint("https://h")).toBe(
      "https://h/v1/embeddings/multimodal",
    );
  });
});

describe("toMultimodalInputParts", () => {
  it("图片在前文本在后", () => {
    const parts = toMultimodalInputParts({
      text: "说明",
      images: ["data:image/png;base64,AA"],
    });
    expect(parts).toEqual([
      { type: "image", imageUrl: "data:image/png;base64,AA" },
      { type: "text", text: "说明" },
    ]);
  });

  it("空文本不出 text 片段", () => {
    const parts = toMultimodalInputParts({ text: "  ", images: [] });
    expect(parts).toHaveLength(0);
  });
});

describe("parseMultimodalEmbedding", () => {
  it("对象形态 data.embedding", () => {
    const v = parseMultimodalEmbedding({
      data: { embedding: [1, 2, 3] },
    });
    expect(Array.from(v)).toEqual([1, 2, 3]);
  });

  it("兼容数组形态", () => {
    const v = parseMultimodalEmbedding({
      data: [{ embedding: [0.1, 0.2] }],
    });
    expect(v).toHaveLength(2);
  });

  it("坏形态抛错", () => {
    expect(() => parseMultimodalEmbedding(null)).toThrow();
    expect(() =>
      parseMultimodalEmbedding({ data: { embedding: "x" } }),
    ).toThrow();
    expect(() => parseMultimodalEmbedding({ data: {} })).toThrow();
  });
});

describe("isUsableImageUrl", () => {
  it("data:image / http(s) 为真", () => {
    expect(isUsableImageUrl("data:image/jpeg;base64,xx")).toBe(true);
    expect(isUsableImageUrl("https://a/x.png")).toBe(true);
  });
  it("其它为假", () => {
    expect(isUsableImageUrl(123)).toBe(false);
    expect(isUsableImageUrl("foo")).toBe(false);
    expect(isUsableImageUrl("nothttp://a")).toBe(false);
  });
});

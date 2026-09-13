// apps/api/src/routes/__tests__/search-bounds.test.ts
// M1/S11（ADR-0005）：锁定搜索「有界预览」口径——两个搜索端点共用同一上限与响应标记，
// 防止一处改 2000、另一处漂移，或标记字段被悄悄改名（前端据 boundedPreview 提示"预览"）。

import { describe, it, expect } from "vitest";
import {
  SEARCH_PREVIEW_LIMIT,
  boundedPreviewMarker,
} from "../searchBounds.js";

describe("search bounded preview (ADR-0005)", () => {
  it("上限固定为 2000（M1 显式登记值）", () => {
    expect(SEARCH_PREVIEW_LIMIT).toBe(2000);
  });

  it("标记形状稳定：boundedPreview=true 且回带上限", () => {
    expect(boundedPreviewMarker()).toEqual({
      boundedPreview: true,
      previewLimit: 2000,
    });
  });
});

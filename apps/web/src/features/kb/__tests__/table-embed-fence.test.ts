// 文档侧「插入数据表」的 Markdown 协议回归：```table-embed 围栏 ↔ 占位节点 ↔ 解析。
//
// 三处必须同一口径（任一改形都会让已落库的文档解析不出数据表）：
//   mentions.ts       构造/解析（tableEmbedFence / extractTableEmbeds）
//   @gx/blocks        渲染（renderMarkdown → <div class="md-table-embed">）

import { describe, it, expect } from "vitest";
import { renderMarkdown } from "@gx/blocks";
import { tableEmbedFence, extractTableEmbeds } from "../mentions";

describe("table-embed 围栏协议", () => {
  it("带视图：fence → 占位节点带 table-id + view-id", () => {
    const html = renderMarkdown(tableEmbedFence("tbl1", "v9"));
    expect(html).toContain('class="md-table-embed"');
    expect(html).toContain('data-table-id="tbl1"');
    expect(html).toContain('data-view-id="v9"');
  });

  it("不带视图：只带 table-id（由后端回落到该表默认视图）", () => {
    const html = renderMarkdown(tableEmbedFence("tbl2", null));
    expect(html).toContain('data-table-id="tbl2"');
    expect(html).not.toContain("data-view-id");
  });

  it("extractTableEmbeds 与 fence 构造一致（同表不同视图算两处）", () => {
    expect(extractTableEmbeds(tableEmbedFence("tbl1", "v9"))).toEqual([{ tableId: "tbl1", viewId: "v9" }]);
    expect(extractTableEmbeds(tableEmbedFence("tbl2", null))).toEqual([{ tableId: "tbl2", viewId: null }]);
    const both = tableEmbedFence("tbl1", "v1") + "\n" + tableEmbedFence("tbl1", "v2") + "\n" + tableEmbedFence("tbl1", "v1");
    expect(extractTableEmbeds(both)).toEqual([
      { tableId: "tbl1", viewId: "v1" },
      { tableId: "tbl1", viewId: "v2" },
    ]);
  });
});

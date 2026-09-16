// M5/S3 chunks 纯函数表驱动测试（零 IO）：
// record identity 无业务值、field 拼接对齐旧 search.ts:93-95、可搜索类型白名单、
// 空值/计算/附件剔除、类型优先级 -> 创建序 -> fieldId 确定性取舍、N=50 边界（49/50/51）、
// doc h1-h3 + 滑窗 overlap64 骨架、canvas 按元素骨架与非法 JSON。

import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_DEPTH,
  CANVAS_MAX_VALUES,
  DOC_OVERLAP,
  DOC_TARGET_MAX,
  DOC_TARGET_MIN,
  FIELD_CHUNK_CAP,
  buildCanvasIdentityChunks,
  buildDocChunksFromMarkdown,
  buildDocIdentityChunks,
  buildRecordChunks,
  collectCanvasTextElements,
  extractFieldText,
  isSearchableFieldType,
  splitMarkdownHeadings,
  windowText,
  type RecordChunkInput,
  type RecordFieldInput,
} from "../chunks.js";

function padId(n: number): string {
  return `f${String(n).padStart(2, "0")}`;
}

function makeFields(count: number, type: string = "singleLineText"): RecordFieldInput[] {
  return Array.from({ length: count }, (_, i) => ({
    fieldId: padId(i + 1),
    name: `字段${i + 1}`,
    type,
    order: i + 1,
    createdAt: 1_000 + i,
    value: `v${i + 1}`,
  }));
}

function makeRecord(fields: RecordFieldInput[]): RecordChunkInput {
  return {
    recordId: "rec1",
    tableNodeId: "nodeT1",
    tableName: "客户表",
    baseName: "销售库",
    primaryFieldId: "f01",
    fields,
  };
}

describe("常量 Q7", () => {
  it("FIELD_CHUNK_CAP = 50（软上限默认）", () => {
    expect(FIELD_CHUNK_CAP).toBe(50);
  });
  it("doc 滑窗参数 300-512 / overlap 64", () => {
    expect(DOC_TARGET_MIN).toBe(300);
    expect(DOC_TARGET_MAX).toBe(512);
    expect(DOC_OVERLAP).toBe(64);
  });
  it("画布保护阈：深度 12、2000 值", () => {
    expect(CANVAS_MAX_DEPTH).toBe(12);
    expect(CANVAS_MAX_VALUES).toBe(2000);
  });
});

describe("isSearchableFieldType：可搜索白名单", () => {
  const searchable = [
    "singleLineText", "longText", "richText", "number", "currency", "percent",
    "duration", "date", "datetime", "checkbox", "rating", "singleSelect",
    "multiSelect", "email", "url", "phone", "autoNumber",
  ];
  const excluded = [
    "attachment", "formula", "lookup", "rollup", "count", "links", "subtable",
    "tabs", "json", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy",
  ];
  for (const t of searchable) {
    it(`${t} 可搜索`, () => expect(isSearchableFieldType(t)).toBe(true));
  }
  for (const t of excluded) {
    it(`${t} 剔除`, () => expect(isSearchableFieldType(t)).toBe(false));
  }
});

describe("extractFieldText：对齐旧 search.ts:93-95", () => {
  it("LinkRef 数组取对象 title，', ' 拼接", () => {
    const refs = [{ tableId: "t", recordId: "r1", title: "甲方公司" }, { tableId: "t", recordId: "r2", title: "乙方公司" }];
    expect(extractFieldText(refs)).toBe("甲方公司, 乙方公司");
  });
  it("对象数组元素无 title 时 String(x)（含 [object Object] 口径一致）", () => {
    expect(extractFieldText([{ x: 1 }])).toBe("[object Object]");
  });
  it("标量数组 ', ' 拼接", () => {
    expect(extractFieldText(["a", "b", "c"])).toBe("a, b, c");
  });
  it("非数组 String(v)", () => {
    expect(extractFieldText(42)).toBe("42");
    expect(extractFieldText(true)).toBe("true");
    expect(extractFieldText("文本")).toBe("文本");
  });
  it("null/undefined -> 空串", () => {
    expect(extractFieldText(null)).toBe("");
    expect(extractFieldText(undefined)).toBe("");
  });
});

describe("buildRecordChunks：identity 不含任何业务值", () => {
  const result = buildRecordChunks(makeRecord([
    { fieldId: "f01", name: "客户名", type: "singleLineText", order: 1, value: "机密客户有限公司" },
    { fieldId: "f02", name: "金额", type: "currency", order: 2, value: 99999 },
  ]));

  it("identity chunk 固定 1 个、seq=0、chunkId 形态正确", () => {
    expect(result.identity.chunkKind).toBe("identity");
    expect(result.identity.seq).toBe(0);
    expect(result.identity.fieldId).toBeNull();
    expect(result.identity.chunkId).toBe("record:rec1");
    expect(result.identity.nodeId).toBe("nodeT1");
  });

  it("identity title/body 只含定位信息（record id/表名/base 名），不含任何字段值", () => {
    expect(result.identity.title).toBe("rec1");
    expect(result.identity.body).toContain("客户表");
    expect(result.identity.body).toContain("销售库");
    expect(result.identity.body).toContain("rec1");
    expect(result.identity.body).not.toContain("机密客户有限公司");
    expect(result.identity.body).not.toContain("99999");
  });

  it("chunks[0] 恒为 identity", () => {
    expect(result.chunks[0].chunkKind).toBe("identity");
  });
});

describe("buildRecordChunks：field chunk 产出与剔除", () => {
  it("有值可搜索字段 1 字段 1 chunk，body=字段文本、title=字段名、chunkId 含 fieldId", () => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "fa", name: "名称", type: "singleLineText", order: 1, value: "hello" },
    ]));
    expect(result.fieldChunks).toHaveLength(1);
    const fc = result.fieldChunks[0];
    expect(fc).toMatchObject({
      chunkKind: "field",
      chunkId: "record:rec1:f:fa",
      fieldId: "fa",
      title: "名称",
      body: "hello",
      nodeId: "nodeT1",
      seq: 1,
    });
  });

  it.each([
    ["空串", ""],
    ["null", null],
    ["undefined", undefined],
    ["空数组", []],
    ["空字符串数组", [""]],
  ])("实际无值（%s）不建 field chunk", (_label, value) => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "fa", name: "n", type: "singleLineText", order: 1, value },
    ]));
    expect(result.fieldChunks).toHaveLength(0);
    expect(result.meta.totalCandidates).toBe(0);
  });

  it("全空白串对齐旧 search.ts:92 口径视为有值（非空串即建 chunk）", () => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "fa", name: "n", type: "singleLineText", order: 1, value: "   " },
    ]));
    expect(result.fieldChunks).toHaveLength(1);
    expect(result.fieldChunks[0].body).toBe("   ");
  });

  it("计算类型（formula/links/lookup/rollup/count/subtable）即使有值也剔除", () => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "f1", name: "公式", type: "formula", order: 1, value: "1+1" },
      { fieldId: "f2", name: "关联", type: "links", order: 2, value: [{ title: "x" }] },
      { fieldId: "f3", name: "查找", type: "lookup", order: 3, value: "v" },
      { fieldId: "f4", name: "汇总", type: "rollup", order: 4, value: 3 },
      { fieldId: "f5", name: "计数", type: "count", order: 5, value: 1 },
      { fieldId: "f6", name: "子表", type: "subtable", order: 6, value: [] },
    ]));
    expect(result.fieldChunks).toHaveLength(0);
  });

  it("附件/tabs/json 剔除，普通文本保留", () => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "att", name: "附件", type: "attachment", order: 1, value: [{ name: "a.pdf" }] },
      { fieldId: "tabs", name: "分页", type: "tabs", order: 2, value: { x: 1 } },
      { fieldId: "js", name: "JSON", type: "json", order: 3, value: { a: 1 } },
      { fieldId: "txt", name: "文本", type: "singleLineText", order: 4, value: "保留" },
    ]));
    expect(result.fieldChunks.map((c) => c.fieldId)).toEqual(["txt"]);
  });
});

describe("buildRecordChunks：确定性取舍排序", () => {
  it("类型优先级：文本类先于数值类，即使数值字段创建更早", () => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "num", name: "数字", type: "number", order: 1, createdAt: 1, value: 1 },
      { fieldId: "txt", name: "文本", type: "singleLineText", order: 2, createdAt: 2, value: "x" },
    ]));
    expect(result.fieldChunks.map((c) => c.fieldId)).toEqual(["txt", "num"]);
  });

  it("文本三型同优先级，选择/联系标量为次档，数值日期为末档", () => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "d", name: "日期", type: "date", order: 3, createdAt: 3, value: "2026-01-01" },
      { fieldId: "s", name: "选项", type: "singleSelect", order: 2, createdAt: 2, value: "A" },
      { fieldId: "l", name: "长文", type: "longText", order: 1, createdAt: 1, value: "正文" },
    ]));
    expect(result.fieldChunks.map((c) => c.fieldId)).toEqual(["l", "s", "d"]);
  });

  it("同类型按创建顺序（order）；order 相同按 fieldId 字典序", () => {
    const byOrder = buildRecordChunks(makeRecord([
      { fieldId: "b", name: "b", type: "singleLineText", order: 2, value: "2" },
      { fieldId: "a", name: "a", type: "singleLineText", order: 1, value: "1" },
    ]));
    expect(byOrder.fieldChunks.map((c) => c.fieldId)).toEqual(["a", "b"]);

    const byId = buildRecordChunks(makeRecord([
      { fieldId: "f10", name: "10", type: "singleLineText", order: 1, value: "x" },
      { fieldId: "f02", name: "2", type: "singleLineText", order: 1, value: "x" },
    ]));
    expect(byId.fieldChunks.map((c) => c.fieldId)).toEqual(["f02", "f10"]);
  });

  it("createdAt ISO 字符串可作创建序", () => {
    const result = buildRecordChunks(makeRecord([
      { fieldId: "new", name: "n", type: "singleLineText", createdAt: "2026-05-02T00:00:00Z", value: "a" },
      { fieldId: "old", name: "o", type: "singleLineText", createdAt: "2026-01-01T00:00:00Z", value: "b" },
    ]));
    expect(result.fieldChunks.map((c) => c.fieldId)).toEqual(["old", "new"]);
  });
});

describe("buildRecordChunks：N=50 确定性截断边界", () => {
  it("49 候选：不截断，emitted=49 capped=false", () => {
    const r = buildRecordChunks(makeRecord(makeFields(49)));
    expect(r.meta).toMatchObject({ cap: 50, totalCandidates: 49, emitted: 49, capped: false });
    expect(r.fieldChunks).toHaveLength(49);
    expect(r.meta.droppedFieldIds).toEqual([]);
  });

  it("50 候选：恰好不截断，emitted=50 capped=false", () => {
    const r = buildRecordChunks(makeRecord(makeFields(50)));
    expect(r.meta).toMatchObject({ cap: 50, totalCandidates: 50, emitted: 50, capped: false });
    expect(r.fieldChunks).toHaveLength(50);
  });

  it("51 候选：截 1，capped=true，被截的是确定性排序最后一个", () => {
    const r = buildRecordChunks(makeRecord(makeFields(51)));
    expect(r.meta).toMatchObject({ cap: 50, totalCandidates: 51, emitted: 50, capped: true });
    expect(r.fieldChunks).toHaveLength(50);
    expect(r.meta.droppedFieldIds).toEqual(["f51"]);
    expect(r.fieldChunks.map((c) => c.fieldId)).not.toContain("f51");
  });

  it("101 候选：截 51，dropped 按取舍序为 f51..f101", () => {
    const r = buildRecordChunks(makeRecord(makeFields(101)));
    expect(r.meta.emitted).toBe(50);
    expect(r.meta.droppedFieldIds).toHaveLength(51);
    expect(r.meta.droppedFieldIds[0]).toBe("f51");
    expect(r.meta.droppedFieldIds[50]).toBe("f101");
  });

  it("截断时低优先级类型（数值）排在全部文本之后，最先被丢", () => {
    // 恰好 50 个文本（占满 cap）+ 1 个更早创建的数值：数值排序全局末位，被唯一截掉
    const fields = makeFields(50, "singleLineText");
    fields.push({ fieldId: "numEarly", name: "数字", type: "number", order: 0, createdAt: 0, value: 1 });
    const r = buildRecordChunks(makeRecord(fields));
    expect(r.meta.capped).toBe(true);
    expect(r.meta.droppedFieldIds).toEqual(["numEarly"]);
    expect(r.fieldChunks.every((c) => c.fieldId !== "numEarly")).toBe(true);
  });

  it("cap 可被参数覆盖（自定义 N=2），默认仍 50", () => {
    const r2 = buildRecordChunks(makeRecord(makeFields(5)), 2);
    expect(r2.meta.cap).toBe(2);
    expect(r2.meta.emitted).toBe(2);
    expect(r2.meta.droppedFieldIds).toEqual(["f03", "f04", "f05"]);
  });

  it("非法 cap 抛错", () => {
    expect(() => buildRecordChunks(makeRecord([]), 0)).toThrow();
    expect(() => buildRecordChunks(makeRecord([]), -1)).toThrow();
    expect(() => buildRecordChunks(makeRecord([]), 1.5)).toThrow();
  });

  it("chunks 总数 = 1 identity + emitted，seq 连续 0..N", () => {
    const r = buildRecordChunks(makeRecord(makeFields(51)));
    expect(r.chunks).toHaveLength(51);
    expect(r.chunks.map((c) => c.seq)).toEqual(Array.from({ length: 51 }, (_, i) => i));
  });
});

describe("buildRecordChunks：可重放确定性", () => {
  it("同输入两次结果深度一致（含乱序字段定义输入）", () => {
    const f1 = makeFields(30);
    const f2 = [...f1].reverse();
    expect(buildRecordChunks(makeRecord(f1))).toEqual(buildRecordChunks(makeRecord(f2)));
  });
});

describe("doc 骨架：h1-h3 粗切 + 超长滑窗（TODO S5 接去标记文本）", () => {
  it("splitMarkdownHeadings 按 h1-h3 分节并保留标题路径，h4 不切", () => {
    const md = ["引言行", "# 第一章", "甲", "## 1.1", "乙", "#### 深标题", "丙", "# 第二章", "丁"].join("\n");
    const sections = splitMarkdownHeadings(md);
    expect(sections.map((s) => s.headingPath)).toEqual([
      [],
      ["第一章"],
      ["第一章", "1.1"],
      ["第二章"],
    ]);
    expect(sections[2].text).toContain("乙");
    expect(sections[2].text).toContain("深标题");
    expect(sections[2].text).toContain("丙");
  });

  it("空节（标题后直接下一标题）被过滤，内容归入实际所在节", () => {
    const sections = splitMarkdownHeadings("引言\n# A\n# B\n正文");
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.headingPath)).toEqual([[], ["B"]]);
    expect(sections[1].text).toBe("正文");
  });

  it("windowText：短文本一窗；超长按码点切窗且相邻窗 overlap 64 码点", () => {
    expect(windowText("短")).toEqual(["短"]);
    const text = "字".repeat(600);
    const wins = windowText(text, DOC_TARGET_MAX, DOC_OVERLAP);
    expect(wins[0]).toHaveLength(DOC_TARGET_MAX);
    expect(Array.from(wins[0]).length).toBe(512);
    expect(Array.from(wins[wins.length - 1]).length).toBeLessThanOrEqual(512);
    // step = 512-64 = 448；600 字 => 窗 [0,512) [448,960)->截到 600，共 2 窗
    expect(wins).toHaveLength(2);
    const overlap = wins[0].slice(wins[0].length - 64);
    expect(wins[1].startsWith(overlap)).toBe(true);
  });

  it("overlap >= targetMax 抛错（防死循环）", () => {
    expect(() => windowText("x".repeat(100), 10, 10)).toThrow();
  });

  it("buildDocIdentityChunks：全部 identity 类、chunkId/seq 连续、nodeId 正确", () => {
    const out = buildDocIdentityChunks({
      docId: "d1", nodeId: "nodeD1", title: "说明文档", plainText: "字".repeat(600),
    });
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.chunkKind === "identity" && c.entityType === "doc")).toBe(true);
    expect(out[0]).toMatchObject({ chunkId: "doc:d1:0", title: "说明文档", seq: 0, nodeId: "nodeD1" });
    expect(out[1].title).toBe("说明文档 #2");
    expect(out[1].seq).toBe(1);
  });

  it("空文本不产 doc chunk", () => {
    expect(buildDocIdentityChunks({ docId: "d", nodeId: "n", title: "t", plainText: "   " })).toEqual([]);
  });

  it("buildDocChunksFromMarkdown：标题路径进入 title，节内超长再滑窗", () => {
    const md = `# 标题一\n${"a".repeat(600)}\n## 标题二\n短节`;
    const out = buildDocChunksFromMarkdown({ docId: "d", nodeId: "n", title: "文档", markdown: md });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].title).toBe("文档 / 标题一");
    const last = out[out.length - 1];
    expect(last.title).toBe("文档 / 标题一 / 标题二");
    expect(last.body).toBe("短节");
    expect(out.every((c) => c.seq === out.indexOf(c))).toBe(true);
  });
});

describe("canvas 骨架：按含文本元素 1 chunk（TODO S5 接真实画布数据）", () => {
  it("每个含 text/label 元素产出一片，gxNote 附加同片", () => {
    const json = JSON.stringify({
      children: [
        { type: "node", text: "节点一" },
        { type: "node", label: "节点二", gxNote: "批注二" },
        { type: "node", children: [{ text: "嵌套节点三" }] },
        { type: "shape", x: 1 },
      ],
    });
    const out = buildCanvasIdentityChunks({ canvasId: "c1", nodeId: "nodeC1", title: "白板", contentJson: json });
    expect(out).not.toBeNull();
    expect(out?.chunks).toHaveLength(3);
    expect(out?.chunks.map((c) => c.body)).toEqual(["节点一", "节点二 批注二", "嵌套节点三"]);
    expect(out?.chunks[0]).toMatchObject({
      chunkKind: "identity", entityType: "canvas", chunkId: "canvas:c1:0", nodeId: "nodeC1", seq: 0,
    });
    expect(out?.truncated).toBe(false);
  });

  it("空白/空 JSON 返回空集不抛错", () => {
    expect(buildCanvasIdentityChunks({ canvasId: "c", nodeId: "n", title: "t", contentJson: "" })?.chunks).toEqual([]);
    expect(collectCanvasTextElements("   ")).toEqual({ texts: [], truncated: false });
  });

  it("非法 JSON 返回 null（接线片记 metric，不静默产错片）", () => {
    expect(buildCanvasIdentityChunks({ canvasId: "c", nodeId: "n", title: "t", contentJson: "{bad" })).toBeNull();
  });

  it("超过 2000 值确定性截断并标 truncated=true", () => {
    const els = Array.from({ length: CANVAS_MAX_VALUES + 50 }, (_, i) => ({ text: `t${i}` }));
    const out = collectCanvasTextElements(JSON.stringify(els));
    expect(out?.texts).toHaveLength(CANVAS_MAX_VALUES);
    expect(out?.truncated).toBe(true);
  });

  it("深度超过 12 的文本不再收集", () => {
    let node: unknown = { text: "deep" };
    for (let i = 0; i < CANVAS_MAX_DEPTH + 2; i++) node = { child: node };
    const out = collectCanvasTextElements(JSON.stringify(node));
    expect(out?.texts).toEqual([]);
  });
});

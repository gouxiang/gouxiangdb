// 记录「数据日志」前端接线单测（node 环境，无 jsdom / 无 DOM 交互）。
//
// 覆盖三块免 DOM 的部分：
//   ① client.ts 的契约解析纯函数（防御性：404 之外的脏数据也不能崩）；
//   ② 弹窗里的两个展示纯函数（值格式化 / 操作人解析）；
//   ③ 取数接线本身：queryKey 形状 + Records.changes 拼出的 URL。
//
// 不覆盖：Modal 的开关与焦点管理（依赖 document，走 UI 库既有实现，本轮未改）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRecordChanges, sortRecordChangesDesc, type RecordChangeEntry } from "../../api/client";
import { EMPTY_CHANGES_TEXT, formatChangeValue, resolveActorName } from "./RecordChangesModal";

describe("parseRecordChanges：后端契约防御性解析", () => {
  it("非对象 / 缺 changes 键 / changes 不是数组 → 空列表（端点 404 或旧形态不崩）", () => {
    expect(parseRecordChanges(null)).toEqual([]);
    expect(parseRecordChanges(undefined)).toEqual([]);
    expect(parseRecordChanges("not json")).toEqual([]);
    expect(parseRecordChanges({})).toEqual([]);
    expect(parseRecordChanges({ changes: "oops" })).toEqual([]);
  });

  it("标准响应按 changedAt 倒序（新的在上）", () => {
    const out = parseRecordChanges({
      changes: [
        { id: "c1", op: "create", actorId: "u1", actorName: "戴静", changedAt: "2026-10-02T21:38:39.000Z", changes: [] },
        { id: "c2", op: "update", actorId: "u2", actorName: "张三", changedAt: "2026-10-02T21:40:00.000Z", changes: [] },
      ],
    });
    expect(out.map((e) => e.id)).toEqual(["c2", "c1"]);
  });

  it("条目缺字段 / op 是没见过的枚举 → 兜底不丢条目", () => {
    const out = parseRecordChanges({
      changes: [
        { op: "archive", changedAt: "2026-10-02T21:40:00.000Z" },
        null,
        { id: "c3", op: "delete", changedAt: "2026-10-01T10:00:00.000Z", changes: "bad" },
      ],
    });
    // null 条目被丢掉（无法构造），其余保留
    expect(out).toHaveLength(2);
    expect(out[0]!.op).toBe("update"); // 未知 op 降级为 update
    expect(out[0]!.id).toBe("record-change-0"); // 缺 id 用下标兜底 key
    expect(out[0]!.actorId).toBeNull();
    expect(out[0]!.actorName).toBeNull();
    expect(out[1]!.changes).toEqual([]); // changes 非数组降级为空
    expect(out[1]!.op).toBe("delete");
  });

  it("时间缺失 / 非法 → 排到末尾且保持原相对顺序", () => {
    const out = parseRecordChanges({
      changes: [
        { id: "no-time", op: "update" },
        { id: "bad-time", op: "update", changedAt: "not-a-date" },
        { id: "ok", op: "update", changedAt: "2026-10-02T21:40:00.000Z" },
      ],
    });
    expect(out.map((e) => e.id)).toEqual(["ok", "no-time", "bad-time"]);
  });

  it("字段级 before/after 缺失归一为 null；fieldName 缺时退回 fieldId", () => {
    const out = parseRecordChanges({
      changes: [
        {
          id: "c1",
          op: "update",
          changedAt: "2026-10-02T21:40:00.000Z",
          changes: [
            { fieldId: "fld_title", before: null, after: "新标题" },
            { fieldId: "fld_num", fieldName: "数量" },
          ],
        },
      ],
    });
    expect(out[0]!.changes[0]).toMatchObject({ fieldId: "fld_title", fieldName: "fld_title", before: null, after: "新标题" });
    expect(out[0]!.changes[1]).toMatchObject({ fieldId: "fld_num", fieldName: "数量", before: null, after: null });
  });
});

describe("sortRecordChangesDesc：稳定倒序", () => {
  const e = (id: string, at: string): RecordChangeEntry => ({
    id,
    op: "update",
    actorId: null,
    actorName: null,
    changedAt: at,
    changes: [],
  });
  it("同秒多条保持原顺序（不因排序抖动）", () => {
    const out = sortRecordChangesDesc([
      e("a", "2026-10-02T21:40:00.000Z"),
      e("b", "2026-10-02T21:40:00.000Z"),
      e("c", "2026-10-02T21:41:00.000Z"),
    ]);
    expect(out.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
  it("不修改入参数组", () => {
    const src = [e("a", "2026-10-02T21:40:00.000Z")];
    sortRecordChangesDesc(src);
    expect(src[0]!.id).toBe("a");
  });
});

describe("formatChangeValue：变更值展示", () => {
  it("空值一律显示「空」", () => {
    expect(formatChangeValue(null)).toBe("空");
    expect(formatChangeValue(undefined)).toBe("空");
    expect(formatChangeValue("")).toBe("空");
    expect(formatChangeValue([])).toBe("空");
  });
  it("标量直出；数组顿号连接；对象给 JSON 摘要而不是 [object Object]", () => {
    expect(formatChangeValue("草稿")).toBe("草稿");
    expect(formatChangeValue(0)).toBe("0");
    expect(formatChangeValue(false)).toBe("false");
    expect(formatChangeValue(["甲", "乙"])).toBe("甲、乙");
    expect(formatChangeValue({ id: "o1" })).toBe('{"id":"o1"}');
  });
  it("超长值截断，不撑爆弹窗", () => {
    const long = "x".repeat(500);
    const out = formatChangeValue(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("resolveActorName：操作人解析", () => {
  const roster = new Map([["u1", { id: "u1", displayName: "戴静", email: "d@x.com", avatarUrl: null }]]);
  it("后端给了 actorName 就直接用它（不覆盖）", () => {
    expect(resolveActorName({ actorName: "系统导入", actorId: "u1" }, roster)).toBe("系统导入");
  });
  it("没给名字就查成员名册", () => {
    expect(resolveActorName({ actorName: null, actorId: "u1" }, roster)).toBe("戴静");
  });
  it("名册里查不到 → 退回 userId 原文，不留空白", () => {
    expect(resolveActorName({ actorName: null, actorId: "u_unknown" }, roster)).toBe("u_unknown");
  });
  it("既无名字也无 id → 系统", () => {
    expect(resolveActorName({ actorName: null, actorId: null }, roster)).toBe("系统");
  });
});

describe("空态文案常量", () => {
  it("接口 404 / 无数据时共用同一句空态文案", () => {
    expect(EMPTY_CHANGES_TEXT).toBe("暂无变更记录");
  });
});

describe("取数接线：queryKey 与请求路径", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("QK.recordChanges 按 recordId 分桶", async () => {
    const { QK } = await import("../../api/hooks");
    expect(QK.recordChanges("rec_1")).toEqual(["recordChanges", "rec_1"]);
    expect(QK.recordChanges("rec_1")).not.toEqual(QK.recordChanges("rec_2"));
  });

  it("Records.changes 命中 GET /api/records/:id/changes?limit=100", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ changes: [] }),
        } as unknown as Response;
      }),
    );
    // 动态 import：必须在 stub 之后取模块，确保用的是被 stub 的 fetch
    const { Records } = await import("../../api/client");
    await Records.changes("rec_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/records/rec_1/changes");
    expect(calls[0]).toContain("limit=100");
  });

  it("显式传 limit 时按传入值拼（不写死 100）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ changes: [] }) } as unknown as Response;
      }),
    );
    const { Records } = await import("../../api/client");
    await Records.changes("rec_2", 20);
    expect(calls[0]).toContain("limit=20");
    expect(calls[0]).not.toContain("limit=100");
  });
});

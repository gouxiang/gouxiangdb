// M6/S6b @gx/canvas 校验器表驱动单测（纯函数，Node 环境，无 DB/IO）。
// 六类坏输入各至少一例且必须给出明确 code（UNSUPPORTED_OPERATION 可断言、不许静默成功）；
// 外加正常尾插、appendedIds、id 双唯一、宽高非正拒绝、gxLinkRef/gxDocRef 拒绝、普通键透传、字节双上限。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANVAS_LIMITS,
  SUPPORTED_OPS,
  createIdGenerator,
  parseBoardContent,
  validateCreateOps,
  type CanvasLimits,
} from "../index.js";

const rect = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "geometry",
  shape: "rectangle",
  points: [[0, 0], [100, 80]],
  ...extra,
});
const createOp = (element: Record<string, unknown>) => ({ op: "element.create", element });

/** 从校验结果取成功态（失败时带 message 抛错）。 */
function okOf(r: ReturnType<typeof validateCreateOps>): Extract<typeof r, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok but got ${r.code}: ${r.message}`);
  return r;
}
/** 断言失败并返回错误态（便于继续断 code/supported）。 */
function failOf(r: ReturnType<typeof validateCreateOps>): Extract<typeof r, { ok: false }> {
  if (r.ok) throw new Error("expected failure but got ok");
  return r;
}

describe("parseBoardContent（与读侧同口径）", () => {
  it("空串/null/纯空白 -> 空板，parseError=false", () => {
    expect(parseBoardContent("")).toEqual({ elements: [], parseError: false });
    expect(parseBoardContent(null)).toEqual({ elements: [], parseError: false });
    expect(parseBoardContent("   \n\t")).toEqual({ elements: [], parseError: false });
  });
  it("合法数组 -> 原样元素，parseError=false", () => {
    expect(parseBoardContent('[{"id":"a"}]')).toEqual({ elements: [{ id: "a" }], parseError: false });
  });
  it("坏 JSON / 顶层非数组 -> elements:[]，parseError=true（不抛）", () => {
    expect(parseBoardContent("{bad")).toEqual({ elements: [], parseError: true });
    expect(parseBoardContent('{"children":[]}')).toEqual({ elements: [], parseError: true });
  });
});

describe("validateCreateOps：正常路径", () => {
  it("三矩形尾插：长度 +3、既有不动、新元素在尾部、服务端补 id（与入参无关）、appendedIds 对齐", () => {
    const existing = [{ id: "old1", type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]] }];
    const ops = [createOp(rect()), createOp(rect({ points: [[5, 5], [6, 6]] })), createOp(rect())];
    const r = okOf(validateCreateOps(existing, ops));
    expect(r.next).toHaveLength(4);
    expect(r.next[0]).toEqual(existing[0]); // 既有元素不动
    expect(r.elements).toHaveLength(3);
    expect(r.appendedIds).toHaveLength(3);
    expect(r.next.slice(1).map((e) => (e as { id: string }).id)).toEqual(r.appendedIds);
    for (const e of r.next.slice(1)) {
      const id = (e as { id: unknown }).id;
      expect(typeof id).toBe("string");
      expect((id as string).length).toBeGreaterThan(0);
    }
    // 入参元素未被原地改写（校验器拷贝后补 id）
    expect((ops[0]!.element as Record<string, unknown>).id).toBeUndefined();
  });

  it("id 生成：注入生成器的 id 被采用，且批内不与既有 id 冲突（双唯一）", () => {
    const existing = [{ id: "taken" }];
    let n = 0;
    const gen = () => `g${++n}`;
    const r = okOf(validateCreateOps(existing, [createOp(rect()), createOp(rect())], DEFAULT_CANVAS_LIMITS, gen));
    const ids = r.next.map((e) => (e as { id?: unknown }).id);
    expect(ids).toEqual(["taken", "g1", "g2"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.appendedIds).toEqual(["g1", "g2"]);
  });

  it("createIdGenerator：种子含既有字符串/数字 id，抽取不撞、批内唯一", () => {
    const g = createIdGenerator([{ id: "abc" }, { id: 123 }]);
    const a = g();
    const b = g();
    expect(typeof a).toBe("string");
    expect(a).not.toBe("abc");
    expect(b).not.toBe(a);
  });

  it("普通未知键（非 gx 前缀，含 fill/strokeColor/angle 等 plait 原生键）透传保留", () => {
    const ops = [
      createOp(rect({ customMeta: 1, style: { fill: "#fff" } })),
      createOp(rect({ fill: "transparent", strokeColor: "transparent", angle: 0, opacity: 1 })),
      createOp(rect({ gxNote: "注释正文" })),
    ];
    const next = okOf(validateCreateOps([], ops)).next;
    expect((next[0] as Record<string, unknown>).customMeta).toBe(1);
    expect((next[0] as Record<string, unknown>).style).toEqual({ fill: "#fff" });
    expect((next[1] as Record<string, unknown>).fill).toBe("transparent");
    expect((next[1] as Record<string, unknown>).angle).toBe(0);
    expect((next[2] as Record<string, unknown>).gxNote).toBe("注释正文");
  });
});

describe("validateCreateOps：六类坏输入必须明确拒绝（不静默）", () => {
  const cases: Array<{ name: string; ops: unknown[]; code: "UNSUPPORTED_OPERATION" | "INVALID_PARAMS"; supported?: boolean }> = [
    // 1) 自带 id
    { name: "自带 id", ops: [createOp(rect({ id: "evil" }))], code: "INVALID_PARAMS" },
    { name: "id=null 也算自带", ops: [createOp(rect({ id: null }))], code: "INVALID_PARAMS" },
    // 2) zIndex / data-gx / 选区键
    { name: "zIndex 键", ops: [createOp(rect({ zIndex: 5 }))], code: "INVALID_PARAMS" },
    { name: "plait-data-id 键", ops: [createOp(rect({ "plait-data-id": "x" }))], code: "INVALID_PARAMS" },
    { name: "selection 键", ops: [createOp(rect({ selected: true }))], code: "INVALID_PARAMS" },
    { name: "data-gx-* DOM 键", ops: [createOp(rect({ "data-gx-link-fo": "1" }))], code: "INVALID_PARAMS" },
    // 3) 非法 shape/type（二期图元）
    { name: "非法 shape（ellipse）", ops: [createOp(rect({ shape: "ellipse" }))], code: "UNSUPPORTED_OPERATION" },
    { name: "arrow-line 类型", ops: [createOp({ type: "arrow-line", shape: "straight", points: [[0, 0], [1, 1]], source: {}, target: {} })], code: "UNSUPPORTED_OPERATION" },
    { name: "vector-line 类型", ops: [createOp({ type: "vector-line", points: [[0, 0], [1, 1]] })], code: "UNSUPPORTED_OPERATION" },
    { name: "image 类型", ops: [createOp({ type: "image", points: [[0, 0], [1, 1]] })], code: "UNSUPPORTED_OPERATION" },
    // 4) gx 越界 / 二期键
    { name: "gxLinkRef 关联块（二期）", ops: [createOp(rect({ gxLinkRef: { docId: "d", kind: "doc", title: "t" } }))], code: "UNSUPPORTED_OPERATION" },
    { name: "gxDocRef 文档引用（二期）", ops: [createOp(rect({ gxDocRef: { docId: "d1", kind: "doc", title: "标题" } }))], code: "UNSUPPORTED_OPERATION" },
    { name: "gx* 越界未知键", ops: [createOp(rect({ gxEvil: 1 }))], code: "INVALID_PARAMS" },
    // 6) 不支持操作名（绝不静默丢弃）
    { name: "不支持操作名 element.delete", ops: [{ op: "element.delete", element: { id: "x" } }], code: "UNSUPPORTED_OPERATION", supported: true },
    { name: "不支持操作名 element.update", ops: [{ op: "element.update", element: rect() }], code: "UNSUPPORTED_OPERATION", supported: true },
    { name: "不支持操作名 zorder", ops: [{ op: "zorder", element: rect() }], code: "UNSUPPORTED_OPERATION", supported: true },
  ];
  for (const c of cases) {
    it(`${c.name} -> ${c.code}`, () => {
      const r = failOf(validateCreateOps([], c.ops));
      expect(r.code).toBe(c.code);
      expect(r.message.length).toBeGreaterThan(0);
      if (c.supported) expect(r.supported).toEqual([...SUPPORTED_OPS]);
    });
  }
});

describe("validateCreateOps：points / gxNote 细节", () => {
  it("宽高非正（零宽/零高/反向）-> INVALID_PARAMS", () => {
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [[10, 10], [10, 20]] }))])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [[10, 10], [20, 10]] }))])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [[20, 20], [10, 10]] }))])).code).toBe("INVALID_PARAMS");
  });
  it("点数不为 2 / 点非 2 有限数 / NaN Infinity 字符串 -> INVALID_PARAMS", () => {
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [[0, 0]] }))])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [[0, 0, 1], [1, 1]] }))])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [["0", "0"], [1, 1]] }))])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [[0, 0], [Number.NaN, 1]] }))])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], [createOp(rect({ points: [[0, 0], [Number.POSITIVE_INFINITY, 1]] }))])).code).toBe("INVALID_PARAMS");
  });
  it("gxNote 非字符串 -> INVALID_PARAMS", () => {
    expect(failOf(validateCreateOps([], [createOp(rect({ gxNote: 1 }))])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], [createOp(rect({ gxNote: { x: 1 } }))])).code).toBe("INVALID_PARAMS");
  });
  it("缺 type/shape -> UNSUPPORTED；缺 points -> INVALID_PARAMS", () => {
    expect(failOf(validateCreateOps([], [createOp({ shape: "rectangle", points: [[0, 0], [1, 1]] })])).code).toBe("UNSUPPORTED_OPERATION");
    expect(failOf(validateCreateOps([], [createOp({ type: "geometry", points: [[0, 0], [1, 1]] })])).code).toBe("UNSUPPORTED_OPERATION");
    expect(failOf(validateCreateOps([], [createOp({ type: "geometry", shape: "rectangle" })])).code).toBe("INVALID_PARAMS");
  });
});

describe("validateCreateOps：整批限额与原子性", () => {
  it("空 ops / 非数组 ops -> INVALID_PARAMS", () => {
    expect(failOf(validateCreateOps([], [])).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], {})).code).toBe("INVALID_PARAMS");
    expect(failOf(validateCreateOps([], null)).code).toBe("INVALID_PARAMS");
  });
  it("op 条数超 maxOps -> INVALID_PARAMS", () => {
    const limits: CanvasLimits = { maxOps: 2, maxBatchBytes: 10 * 1024 * 1024, maxBoardBytes: 10 * 1024 * 1024 };
    expect(failOf(validateCreateOps([], [createOp(rect()), createOp(rect()), createOp(rect())], limits)).code).toBe("INVALID_PARAMS");
  });
  it("批文本 > 100KB（UTF-8 字节，仅计字符串值）-> INVALID_PARAMS", () => {
    const limits: CanvasLimits = { maxOps: 100, maxBatchBytes: 1024, maxBoardBytes: 10 * 1024 * 1024 };
    const bigNote = "好".repeat(500); // 1500 UTF-8 字节
    expect(failOf(validateCreateOps([], [createOp(rect({ gxNote: bigNote }))], limits)).code).toBe("INVALID_PARAMS");
  });
  it("写入后整板超上限（小 maxBoardBytes 表驱动）-> INVALID_PARAMS 且 ok:false", () => {
    const limits: CanvasLimits = { maxOps: 100, maxBatchBytes: 10 * 1024 * 1024 + 1024, maxBoardBytes: 1024 };
    const r = validateCreateOps([], [createOp(rect({ gxNote: "好".repeat(400) }))], limits); // 1200 字节
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PARAMS");
  });
  it("默认 10MB 上限：既有板在限内、追加一个矩形后整板越界 -> INVALID_PARAMS（批本身 ≤100KB）", () => {
    // 普通字符串键 label（非 gx 前缀，不触发批 100KB 限额）；取整板 JSON 恰在 10MB 之下约 40 字节
    const chars = Math.floor((10 * 1024 * 1024 - 120) / 3);
    const bigExisting = [{ id: "old", type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]], label: "好".repeat(chars) }];
    // 前置：既有板自身仍在 10MB 内（否则证明不了是「写入后」判定）
    expect(new TextEncoder().encode(JSON.stringify(bigExisting)).length).toBeLessThanOrEqual(10 * 1024 * 1024);
    const r = validateCreateOps(bigExisting, [createOp(rect())]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PARAMS");
  });
  it("任一元素坏 -> 整批失败（ok:false，调用方据此原子不落库）", () => {
    const ops = [createOp(rect()), createOp(rect({ id: "evil" }))];
    expect(failOf(validateCreateOps([{ id: "keep" }], ops)).code).toBe("INVALID_PARAMS");
  });
});

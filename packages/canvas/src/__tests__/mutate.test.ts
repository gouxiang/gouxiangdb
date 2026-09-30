// #622 commitElements 纯函数表驱动测试：
//  create/update/move/delete/connect 成功链路 + 目标存在性 + 级联 + 混批原子 + 各类坏输入。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANVAS_LIMITS,
  commitElements,
  connectionPoint,
  rectangleByPoints,
} from "../index.js";

const L = DEFAULT_CANVAS_LIMITS;

function okOf(r: ReturnType<typeof commitElements>) {
  if (!r.ok) throw new Error(`expected ok: ${r.code}: ${r.message}`);
  return r;
}
function failOf(r: ReturnType<typeof commitElements>) {
  if (r.ok) throw new Error("expected failure");
  return r;
}

const rect = (id: string, points: [number, number][] = [
  [0, 0],
  [100, 80],
]): Record<string, unknown> => ({ id, type: "geometry", shape: "rectangle", points });

describe("几何小工具", () => {
  it("rectangleByPoints 外接矩形 / 退化点集 null", () => {
    expect(rectangleByPoints([[0, 0], [10, 20], [5, 30]])).toEqual({ x: 0, y: 0, width: 10, height: 30 });
    expect(rectangleByPoints([[1, 1], [1, 1]])).toEqual({ x: 1, y: 1, width: 0, height: 0 });
    expect(rectangleByPoints("x")).toBeNull();
  });
  it("connectionPoint 比例点 / 越界 null", () => {
    expect(connectionPoint({ x: 10, y: 20, width: 100, height: 40 }, [0.5, 0])).toEqual([60, 20]);
    expect(connectionPoint({ x: 0, y: 0, width: 10, height: 10 }, [2, 0])).toBeNull();
  });
});

describe("commitElements：create 兼容", () => {
  it("create 尾插 + 服务端 id", () => {
    const r = okOf(
      commitElements(
        [rect("a")],
        [{ op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]] } }],
        L,
        () => "new1",
      ),
    );
    expect(r.next).toHaveLength(2);
    expect(r.createdIds).toEqual(["new1"]);
    expect((r.next[1] as Record<string, unknown>).id).toBe("new1");
  });
});

describe("commitElements：update", () => {
  it("更新位置与样式，id 登记", () => {
    const r = okOf(
      commitElements([rect("a")], [{ op: "element.update", id: "a", patch: { fill: "#f00", strokeWidth: 3 } }], L),
    );
    const el = r.next[0] as Record<string, unknown>;
    expect(el.fill).toBe("#f00");
    expect(el.strokeWidth).toBe(3);
    expect(r.updatedIds).toEqual(["a"]);
  });
  it("patch 改 type/shape / 空 patch / 目标不存在 / points 反向 -> INVALID_PARAMS", () => {
    const cases = [
      { id: "a", patch: { type: "image" } },
      { id: "a", patch: {} },
      { id: "missing", patch: { fill: "#000" } },
      { id: "a", patch: { points: [[10, 10], [0, 0]] } },
    ];
    for (const patch of cases) {
      expect(failOf(commitElements([rect("a")], [{ op: "element.update", ...patch }], L)).code).toBe("INVALID_PARAMS");
    }
  });
  it("改连线绑定 source/target -> INVALID_PARAMS；改连线 strokeColor 允许", () => {
    const line = { id: "l1", type: "arrow-line", shape: "straight", points: [[0, 0], [1, 1]], source: {}, target: {} };
    const bad = failOf(commitElements([line], [{ op: "element.update", id: "l1", patch: { source: { boundId: "x" } } }], L));
    expect(bad.code).toBe("INVALID_PARAMS");
    const r = okOf(commitElements([line], [{ op: "element.update", id: "l1", patch: { strokeColor: "#f00" } }], L));
    expect((r.next[0] as Record<string, unknown>).strokeColor).toBe("#f00");
  });
});

describe("commitElements：move", () => {
  it("points 全部平移，id 登记", () => {
    const r = okOf(commitElements([rect("a", [[0, 0], [10, 20]])], [{ op: "element.move", id: "a", dx: 5, dy: -2 }], L));
    expect((r.next[0] as Record<string, unknown>).points).toEqual([[5, -2], [15, 18]]);
    expect(r.movedIds).toEqual(["a"]);
  });
  it("dx/dy 非数 / 同时 0 / 目标连线 -> INVALID_PARAMS", () => {
    const line = { id: "l1", type: "arrow-line", shape: "straight", points: [[0, 0], [1, 1]], source: {}, target: {} };
    expect(failOf(commitElements([rect("a")], [{ op: "element.move", id: "a", dx: "1", dy: 2 }], L)).code).toBe("INVALID_PARAMS");
    expect(failOf(commitElements([rect("a")], [{ op: "element.move", id: "a", dx: 0, dy: 0 }], L)).code).toBe("INVALID_PARAMS");
    expect(failOf(commitElements([rect("a"), line], [{ op: "element.move", id: "l1", dx: 1, dy: 1 }], L)).code).toBe("INVALID_PARAMS");
  });
});

describe("commitElements：delete 与级联", () => {
  const arrow = (id: string, s: string, t: string): Record<string, unknown> => ({
    id,
    type: "arrow-line",
    shape: "straight",
    points: [[0, 0], [1, 1]],
    source: { boundId: s, connection: [0.5, 0.5], marker: "none" },
    target: { boundId: t, connection: [0.5, 0.5], marker: "arrow" },
  });
  it("删除形状：绑定它的 arrow-line 级联删除，未绑定的保留", () => {
    const r = okOf(
      commitElements(
        [rect("a"), rect("b"), rect("c"), arrow("l_ab", "a", "b"), arrow("l_bc", "b", "c")],
        [{ op: "element.delete", id: "a" }],
        L,
      ),
    );
    const ids = r.next.map((e) => (e as { id: string }).id).sort();
    expect(ids).toEqual(["b", "c", "l_bc"]);
    expect(r.deletedIds.sort()).toEqual(["a", "l_ab"]);
  });
  it("两端都绑被删形状只去重一次；删除不存在目标失败", () => {
    const r = okOf(
      commitElements([rect("a"), arrow("self", "a", "a")], [{ op: "element.delete", id: "a" }], L),
    );
    expect(r.deletedIds.sort()).toEqual(["a", "self"]);
    expect(failOf(commitElements([rect("a")], [{ op: "element.delete", id: "x" }], L)).code).toBe("INVALID_PARAMS");
  });
});

describe("commitElements：connect", () => {
  it("arrow-line 绑定两端：points 取连接点、source/target 完整", () => {
    const r = okOf(
      commitElements(
        [rect("a", [[0, 0], [100, 100]]), rect("b", [[200, 0], [300, 100]])],
        [{ op: "element.connect", type: "arrow-line", sourceId: "a", targetId: "b" }],
        L,
        () => "ln1",
      ),
    );
    const el = r.next[2] as Record<string, unknown>;
    expect(el.id).toBe("ln1");
    expect(el.points).toEqual([[50, 50], [250, 50]]);
    expect(el.source).toEqual({ boundId: "a", connection: [0.5, 0.5], marker: "none" });
    expect(el.target).toEqual({ boundId: "b", connection: [0.5, 0.5], marker: "arrow" });
    expect(r.connectedIds).toEqual(["ln1"]);
  });
  it("自定义连接比例与 marker", () => {
    const r = okOf(
      commitElements(
        [rect("a"), rect("b")],
        [{
          op: "element.connect",
          type: "arrow-line",
          sourceId: "a",
          targetId: "b",
          sourceConnection: [0, 0.5],
          targetConnection: [1, 0.5],
          targetMarker: "solid-triangle",
        }],
        L,
        () => "ln2",
      ),
    );
    const el = r.next[2] as Record<string, unknown>;
    expect(el.points).toEqual([[0, 40], [100, 40]]);
    expect((el.target as { marker: string }).marker).toBe("solid-triangle");
  });
  it("vector-line 自由点", () => {
    const r = okOf(
      commitElements([rect("a")], [{ op: "element.connect", type: "vector-line", sourcePoint: [1, 2], targetPoint: [3, 4] }], L, () => "v1"),
    );
    expect(r.next[1]).toEqual({ id: "v1", type: "vector-line", shape: "straight", points: [[1, 2], [3, 4]], opacity: 1 });
  });
  it("坏 connect：端点不存在/绑连线/连接越界/起终点相同/缺端点/marker 非法", () => {
    const line = { id: "l1", type: "arrow-line", shape: "straight", points: [[0, 0], [1, 1]], source: {}, target: {} };
    const cases: Record<string, unknown>[] = [
      { type: "arrow-line", sourceId: "a", targetId: "x" },
      { type: "arrow-line", sourceId: "a", targetId: "l1" },
      { type: "arrow-line", sourceId: "a", targetId: "b", sourceConnection: [2, 0] },
      { type: "vector-line", sourcePoint: [1, 1], targetPoint: [1, 1] },
      { type: "arrow-line", sourceId: "a" },
      { type: "arrow-line", sourceId: "a", targetId: "b", targetMarker: "bogus" },
    ];
    for (const c of cases) {
      expect(failOf(commitElements([rect("a"), rect("b"), line], [{ op: "element.connect", ...c }], L)).code).toBe("INVALID_PARAMS");
    }
  });
});

describe("commitElements：混批与原子", () => {
  it("targetId 非法 -> 整批失败（原子）", () => {
    const r = commitElements(
      [rect("a")],
      [
        { op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[200, 0], [300, 100]] } },
        { op: "element.connect", type: "arrow-line", sourceId: "a", targetId: null },
      ],
      L,
    );
    expect(failOf(r).code).toBe("INVALID_PARAMS");
  });

  it("前两个 op 合法、第三个引用不存在 -> 整批失败", () => {
    const r = commitElements(
      [rect("a")],
      [
        { op: "element.update", id: "a", patch: { fill: "#111" } },
        { op: "element.move", id: "a", dx: 1, dy: 1 },
        { op: "element.delete", id: "ghost" },
      ],
      L,
    );
    expect(failOf(r).code).toBe("INVALID_PARAMS");
  });

  it("混批全合法：create→connect→update→delete 一次应用", () => {
    const r = okOf(
      commitElements(
        [rect("a")],
        [
          { op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[200, 0], [300, 100]] } },
          { op: "element.connect", type: "arrow-line", sourceId: "a", targetId: "b" },
          { op: "element.update", id: "a", patch: { fill: "#222" } },
          { op: "element.move", id: "b", dx: 10, dy: 0 },
        ],
        L,
        (() => {
          let n = 0;
          const ids = ["b", "lab"];
          return () => ids[n++]!;
        })(),
      ),
    );
    expect(r.next).toHaveLength(3); // a(更新) + b(移动) + 连线
    expect((r.next[0] as Record<string, unknown>).fill).toBe("#222");
    expect((r.next[1] as Record<string, unknown>).points).toEqual([[210, 0], [310, 100]]);
    expect(r.createdIds).toEqual(["b"]);
    expect(r.connectedIds).toEqual(["lab"]);
  });

  it("未知 op 名 -> UNSUPPORTED_OPERATION 附 supported", () => {
    const r = failOf(commitElements([rect("a")], [{ op: "zorder", id: "a" }], L));
    expect(r.code).toBe("UNSUPPORTED_OPERATION");
    expect(r.supported).toContain("element.connect");
  });
});

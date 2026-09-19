// P2-A 回归：文档↔画布互嵌的循环/深度防护。
// 分两层测——纯链判定（embed-depth.ts）与挂载决策（enhanceEmbeds.ts 交给 root 的那棵 element）。
// 后者必须 mock react-dom/client：这里跑的是 vitest 的 node 环境，没有真实 DOM；
// 而决策本身（ render CanvasEmbed 还是降级卡、带什么 chain）全写在 element 树上，
// 拦下 root.render 的入参就能断言，不需要 jsdom。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";

const rendered: Array<{ node: ReactNode }> = [];

vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (node: ReactNode) => rendered.push({ node }),
    unmount: () => undefined,
  }),
}));
// CanvasEmbed 一旦被真实挂载就会取数/ Newly import drawnix；这里只需要它的 identity
vi.mock("../CanvasEmbed", () => ({ CanvasEmbed: () => null }));

import { enhanceCanvasEmbeds } from "../enhanceEmbeds";
import { CanvasEmbed } from "../CanvasEmbed";
import { EmbedDepthFallback } from "../EmbedDepthFallback";
import {
  MAX_EMBED_DEPTH,
  ROOT_EMBED_CHAIN,
  chainWithSelf,
  planEmbed,
} from "../embed-depth";

/** 伪造产物容器：把 data-canvas-doc 集合伪装成 querySelectorAll 的命中结果。 */
function fakeContainer(docIds: string[]) {
  const nodes = docIds.map((id) => ({ dataset: { canvasDoc: id } }));
  return { querySelectorAll: () => nodes } as unknown as HTMLElement;
}

type AnyEl = { type?: unknown; props?: Record<string, unknown> };

function walk(node: ReactNode, visit: (el: AnyEl) => void) {
  if (!isValidElement(node)) return;
  const el = node as unknown as AnyEl;
  visit(el);
  const children = el.props?.children;
  if (Array.isArray(children)) children.forEach((c) => walk(c as ReactNode, visit));
  else walk(children as ReactNode, visit);
}

function findNode(node: ReactNode, type: unknown): AnyEl | undefined {
  let hit: AnyEl | undefined;
  walk(node, (el) => {
    if (!hit && el.type === type) hit = el;
  });
  return hit;
}

type Carrier = {
  props: { value: { depth: number; ancestorDocIds: ReadonlySet<string> }; children: ReactNode };
};

function providerOf(node: ReactNode) {
  let value: { depth: number; ancestorDocIds: ReadonlySet<string> } | undefined;
  walk(node, (el) => {
    const p = el.props as Carrier["props"] | undefined;
    if (p && p.value && typeof p.value.depth === "number" && p.value.ancestorDocIds instanceof Set) {
      value = p.value;
    }
  });
  return value as NonNullable<typeof value> | undefined;
}

beforeEach(() => {
  rendered.length = 0;
});

describe("planEmbed：环检测优先于深度限制", () => {
  it("自嵌（画布嵌回宿主自己）即成环，与层数无关", () => {
    const plan = planEmbed("A", chainWithSelf("A"));
    expect(plan.kind).toBe("cycle");
  });

  it("A 嵌 B、B 再嵌 A：第三层判环降级", () => {
    const first = planEmbed("B", chainWithSelf("A"));
    expect(first.kind).toBe("render");
    if (first.kind !== "render") return;
    // B 的内部：祖先含 A、B
    expect(planEmbed("A", first.chain).kind).toBe("cycle");
    expect(planEmbed("B", first.chain).kind).toBe("cycle");
  });

  it(`正常多层仍能渲染：第 ${MAX_EMBED_DEPTH} 层（A→B→C→D）放行到第 ${MAX_EMBED_DEPTH} 层即为上限`, () => {
    let chain = chainWithSelf("A");
    let reached = 0;
    for (const id of ["B", "C", "D"]) {
      const plan = planEmbed(id, chain);
      expect(plan.kind).toBe("render");
      if (plan.kind !== "render") return;
      chain = plan.chain;
      reached = plan.chain.depth;
    }
    expect(reached).toBe(MAX_EMBED_DEPTH);
    expect(chain.depth).toBe(MAX_EMBED_DEPTH);
    expect([...chain.ancestorDocIds].sort()).toEqual(["A", "B", "C", "D"]);
  });

  it(`第 ${MAX_EMBED_DEPTH + 1} 层：超限降级`, () => {
    let chain = chainWithSelf("A");
    for (const id of ["B", "C", "D"]) {
      const plan = planEmbed(id, chain);
      if (plan.kind !== "render") throw new Error(`第 ${id} 层不该被拦`);
      chain = plan.chain;
    }
    const over = planEmbed("E", chain);
    expect(over.kind).toBe("depth");
  });

  it("判定不改入参（每次派生都换新集合），根链保持空", () => {
    const base = chainWithSelf("A");
    planEmbed("B", base);
    expect(base.depth).toBe(0);
    expect([...base.ancestorDocIds]).toEqual(["A"]);
    expect(ROOT_EMBED_CHAIN.depth).toBe(0);
    expect(ROOT_EMBED_CHAIN.ancestorDocIds.size).toBe(0);
  });
});

describe("enhanceCanvasEmbeds：按 planEmbed 的结果决定挂载什么", () => {
  it("放行：挂 CanvasEmbed，并把含宿主+目标的新链交给子树", () => {
    enhanceCanvasEmbeds(fakeContainer(["B"]), {
      canEdit: true,
      chain: chainWithSelf("A"),
    });
    expect(rendered).toHaveLength(1);
    const tree = rendered[0]!.node;
    expect(findNode(tree, CanvasEmbed)).toBeTruthy();
    expect(findNode(tree, EmbedDepthFallback)).toBeUndefined();
    const ctx = providerOf(tree);
    expect(ctx?.depth).toBe(1);
    expect([...(ctx?.ancestorDocIds ?? [])].sort()).toEqual(["A", "B"]);
  });

  it("成环（宿主链里已有该画布）：挂降级卡，一个 CanvasEmbed 都不挂", () => {
    enhanceCanvasEmbeds(fakeContainer(["A"]), {
      canEdit: true,
      chain: chainWithSelf("A"),
    });
    const tree = rendered[0]!.node;
    expect(findNode(tree, CanvasEmbed)).toBeUndefined();
    const fb = findNode(tree, EmbedDepthFallback);
    expect(fb).toBeTruthy();
    expect(fb?.props).toMatchObject({ kind: "cycle", docId: "A" });
  });

  it("超过最大层级：降级卡 kind=depth，且不再产生任何子树", () => {
    let chain = chainWithSelf("A");
    for (const id of ["B", "C", "D"]) {
      const p = planEmbed(id, chain);
      if (p.kind !== "render") throw new Error("前置链不该被拦");
      chain = p.chain;
    }
    enhanceCanvasEmbeds(fakeContainer(["E"]), { canEdit: false, chain });
    const tree = rendered[0]!.node;
    expect(findNode(tree, CanvasEmbed)).toBeUndefined();
    const fb = findNode(tree, EmbedDepthFallback);
    expect(fb?.props).toMatchObject({ kind: "depth", docId: "E" });
  });

  it("同一容器多处占位逐个独立判定，且返回 cleanup", () => {
    const cleanup = enhanceCanvasEmbeds(fakeContainer(["B", "A"]), {
      canEdit: false,
      chain: chainWithSelf("A"),
    });
    expect(rendered).toHaveLength(2);
    expect(findNode(rendered[0]!.node, CanvasEmbed)).toBeTruthy();
    expect(findNode(rendered[1]!.node, EmbedDepthFallback)).toBeTruthy();
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
  });
});

describe("降级卡形态：图标 + 标题 + 跳转按钮", () => {
  it("超限卡带「点击打开」按钮，走的是目标画布地址", () => {
    const html = renderToString(
      createElement(EmbedDepthFallback, {
        docId: "c1",
        kind: "depth",
        kbId: "kb1",
        title: "架构画布",
        targetKind: "canvas",
        onNavigate: () => undefined,
      }),
    );
    expect(html).toContain("data-embed-fallback=\"depth\"");
    expect(html).toContain("架构画布");
    expect(html).toContain("已达嵌套上限");
    expect(html).toContain("点击打开");
  });

  it("环降级卡给出循环文案；无 kbId/无跳转回调时不出按钮（公开分享页不假装能跳）", () => {
    const cycled = renderToString(
      createElement(EmbedDepthFallback, { docId: "c1", kind: "cycle" }),
    );
    expect(cycled).toContain("data-embed-fallback=\"cycle\"");
    expect(cycled).toContain("循环嵌套");
    expect(cycled).not.toContain("点击打开");
  });
});

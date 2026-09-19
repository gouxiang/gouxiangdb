// 附件链接渲染回归（node 环境、react-dom/server + 元素树内省，无 jsdom、无新增依赖）。
//
// 为什么这样测（项目范式：apps/web 无 jsdom / happy-dom / testing-library，且禁新增依赖）：
//   - 取值/裁剪/兜底这类**纯逻辑**抽成 toAttachmentLinks，走值断言（四种情况全覆盖）；
//   - 渲染形态与「链接不被单元格点击吞掉」走**元素树内省**：组件均为无 hook 的纯函数，
//     可直接调用拿到 React 元素树，再手动调用其 onClick/onDoubleClick props 并传入 mock
//     event——这比 readFileSync 源码断言强（断言的是真实 handler 行为），又不需要 DOM；
//   - GridRow 的单元格接线用一段最小冒泡模拟覆盖：验证点链接不到达 td 的
//     选中/进入编辑回调，点空白处照旧到达（既有行为不被破坏）。
//
// 真实浏览器里的下载动作（dataURL + download 属性）无法在 node 环境断言，归入手测清单。

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AttachmentLinks, ATTACHMENT_MAX_VISIBLE, ATTACHMENT_FALLBACK_NAME, toAttachmentLinks } from "./AttachmentLinks";
import { CellRenderer } from "./CellRenderer";
import type { CellValue, FieldDTO } from "@gx/shared-types";

// ---------------------------------------------------------------- 元素树工具
type El = any;

/**
 * 一次性把函数组件展开成**纯宿主元素树**（文本统一为 string）。
 *
 * 必须一次性展开：若每次遍历都重新执行函数组件，拿到的元素是新对象，
 * 与上一次遍历得到的 `<a>` 引用不相等 —— 冒泡模拟会找不到目标路径，
 * 断言退化成"谁都没被调用"的空断言（写这段工具时踩过：去掉 stopPropagation
 * 测试竟然还是绿的）。展开一次后节点引用稳定，collect/bubble 才可信。
 */
function host(node: El): El {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(host).filter((x: El) => x !== null);
  if (typeof node !== "object") return String(node);
  if (typeof node.type === "function") return host(node.type(node.props));
  return { ...node, props: { ...node.props, children: childrenOf(node).map(host).filter((x: El) => x !== null) } };
}

function childrenOf(node: El): unknown[] {
  const kids = node?.props?.children;
  if (kids == null) return [];
  return Array.isArray(kids) ? kids : [kids];
}

/** 在**已 host() 归一化**的树上收集满足条件的宿主元素。 */
function collect(node: El, pred: (el: El) => boolean, acc: El[] = []): El[] {
  if (node == null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const c of node) collect(c, pred, acc);
    return acc;
  }
  if (typeof node.type === "string") {
    if (pred(node)) acc.push(node);
    for (const c of childrenOf(node)) collect(c, pred, acc);
  }
  return acc;
}

/** 汇总整棵树的可见文本（递归拼接叶子字符串，兼容 "+" + N 这类多子节点表达式）。 */
function allText(node: El): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(allText).join("");
  if (typeof node !== "object" || typeof node.type !== "string") return "";
  return childrenOf(node).map(allText).join("");
}

const anchors = (tree: El) => collect(tree, (el) => el.type === "a");

/** 极简 React 合成事件冒泡模拟（输入须为 host() 归一化树）：自目标向上逐层调用 handler，遇 stopPropagation 停止。 */
function bubble(tree: El, target: El, type: "onClick" | "onDoubleClick"): void {
  const path: El[] = [];
  const walk = (node: El, trail: El[]): boolean => {
    if (node == null || typeof node !== "object") return false;
    if (Array.isArray(node)) {
      for (const c of node) if (walk(c, trail)) return true;
      return false;
    }
    const next = [...trail, node];
    if (node === target) {
      path.push(...next);
      return true;
    }
    for (const c of childrenOf(node)) if (walk(c, next)) return true;
    return false;
  };
  const found = walk(tree, []);
  if (!found) throw new Error("bubble: 未在树中找到目标元素（宿主树引用不一致？）");

  let stopped = false;
  const evt = { stopPropagation: () => { stopped = true; } };
  for (let i = path.length - 1; i >= 0; i--) {
    const handler = path[i].props?.[type];
    if (typeof handler === "function") handler(evt);
    if (stopped) return;
  }
}

// ---------------------------------------------------------------- 夹具
const attachmentField = { id: "f1", name: "附件", type: "attachment" } as unknown as FieldDTO;
const file = (n: number, url = `data:text/plain;base64,A${n}`) => ({ id: `f${n}`, name: `文件${n}.txt`, url });
const manyFiles = (n: number) => Array.from({ length: n }, (_, i) => file(i + 1));
/** 附件数组作为 CellValue 传入 CellRenderer（真实运行时由 records.fields 提供） */
const cellValue = (v: unknown) => v as CellValue;

describe("附件取值纯函数 toAttachmentLinks（四种情况 + 脏数据容错）", () => {
  it("空值：null / undefined / 空数组 / 非数组都得到 0 个文件", () => {
    for (const v of [null, undefined, [], "x", 42, { a: 1 }, {}]) {
      expect(toAttachmentLinks(v).items).toHaveLength(0);
    }
    expect(toAttachmentLinks([]).hiddenCount).toBe(0);
  });

  it("单文件：1 项可见、无 +N、名字与 url 原样透传", () => {
    const r = toAttachmentLinks([file(1, "data:text/plain;base64,Q0JD")]);
    expect(r.items).toHaveLength(1);
    expect(r.visible).toHaveLength(1);
    expect(r.hiddenCount).toBe(0);
    expect(r.visible[0]).toEqual({ url: "data:text/plain;base64,Q0JD", name: "文件1.txt" });
  });

  it("多文件未超上限：全部可见，无 +N", () => {
    const r = toAttachmentLinks(manyFiles(4));
    expect(r.visible).toHaveLength(4);
    expect(r.hiddenCount).toBe(0);
  });

  it("超过 4 个：只留前 4 个，剩余折叠为 +N", () => {
    const r = toAttachmentLinks(manyFiles(7));
    expect(r.visible).toHaveLength(ATTACHMENT_MAX_VISIBLE);
    expect(r.items).toHaveLength(7);
    expect(r.hiddenCount).toBe(3);
    expect(r.visible.map((f) => f.name)).toEqual(["文件1.txt", "文件2.txt", "文件3.txt", "文件4.txt"]);
  });

  it("文件名缺失 / 空白 / 非字符串：回退兜底文案，且不丢该项", () => {
    for (const name of [undefined, null, "", "   ", 123, {}]) {
      const r = toAttachmentLinks([{ url: "data:text/plain;base64,QQ", name }]);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].name).toBe(ATTACHMENT_FALLBACK_NAME);
    }
  });

  it("url 缺失：url 归空串，由组件决定不以链接渲染（不抛错）", () => {
    const r = toAttachmentLinks([{ name: "a.txt" }, null, "junk", 7]);
    expect(r.items[0]).toEqual({ url: "", name: "a.txt" });
    expect(r.items).toHaveLength(4);
    expect(r.items.slice(1).every((f) => f.url === "" && f.name === ATTACHMENT_FALLBACK_NAME)).toBe(true);
  });
});

describe("AttachmentLinks 渲染形态：真链接、必带下载安全属性", () => {
  it("渲染出带 href 的 <a>，且 target/rel/download 齐全", () => {
    const a = anchors(host(<AttachmentLinks value={[file(1, "data:text/plain;base64,Q0JD")]} />));
    expect(a).toHaveLength(1);
    expect(a[0].props.href).toBe("data:text/plain;base64,Q0JD");
    expect(a[0].props.target).toBe("_blank");
    expect(a[0].props.rel).toBe("noreferrer");
    // download 是 dataURL 能真正落地的前提：现代浏览器禁止顶层导航到 data: URL
    expect(a[0].props.download).toBe("文件1.txt");
    expect(a[0].props.className).toContain("text-gx-12");
    expect(a[0].props.className).toContain("text-gx-accent");
    expect(a[0].props.className).toContain("underline");
  });

  it("超过 4 个：只渲染 4 个链接 + 一个 +N", () => {
    const tree = host(<AttachmentLinks value={manyFiles(6)} />);
    expect(anchors(tree)).toHaveLength(4);
    expect(allText(tree)).toContain("+2");
  });

  it("url 为空的项不渲染成链接（避免 href='' 跳当前页）", () => {
    const tree = host(<AttachmentLinks value={[{ name: "坏数据.txt", url: "" }, file(2)]} />);
    expect(anchors(tree)).toHaveLength(1);
    expect(anchors(tree)[0].props.href).toBe(`data:text/plain;base64,A2`);
    expect(allText(tree)).toContain("坏数据.txt");
  });

  it("空值不渲染任何链接", () => {
    for (const v of [null, undefined, []]) {
      expect(anchors(host(<AttachmentLinks value={v} />))).toHaveLength(0);
    }
  });
});

describe("网格单元格：链接不被「双击进入编辑」吞掉", () => {
  // GridRow.tsx:142-144 的真实接线：单击=选中，双击=进入编辑
  it("点链接不触发单元格的 click/dblclick 回调", () => {
    const onCellClick = vi.fn();
    const onCellDoubleClick = vi.fn();
    const tree = host(
      <td onClick={onCellClick} onDoubleClick={onCellDoubleClick}>
        {CellRenderer({ value: cellValue(manyFiles(2)), field: attachmentField }) as unknown as React.ReactNode}
      </td>,
    );

    const link = anchors(tree)[0];
    expect(link, "附件单元格必须渲染出真链接").toBeTruthy();

    bubble(tree, link, "onClick");
    bubble(tree, link, "onDoubleClick");
    expect(onCellClick).not.toHaveBeenCalled();
    expect(onCellDoubleClick).not.toHaveBeenCalled();
  });

  it("链接自身的 handler 确实调用了 stopPropagation（click 与 dblclick 两层）", () => {
    const link = anchors(host(<AttachmentLinks value={[file(1)]} />))[0];
    for (const type of ["onClick", "onDoubleClick"] as const) {
      const stop = vi.fn();
      link.props[type]({ stopPropagation: stop, preventDefault: vi.fn() });
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  it("既有行为不变：点单元格空白处仍能到达选中与进入编辑回调", () => {
    const onCellClick = vi.fn();
    const onCellDoubleClick = vi.fn();
    const inner = CellRenderer({ value: cellValue(manyFiles(2)), field: attachmentField }) as El;
    const tree = host(
      <td onClick={onCellClick} onDoubleClick={onCellDoubleClick}>
        {inner as unknown as React.ReactNode}
      </td>,
    );

    // 单元格的空白容器 = wrap() 渲染的根 div（链接的父容器，自身不带 click handler）
    const wrapper = collect(tree, (el) => el.type === "div" && !el.props?.onClick)[0];
    bubble(tree, wrapper, "onClick");
    bubble(tree, wrapper, "onDoubleClick");
    expect(onCellClick).toHaveBeenCalledTimes(1);
    expect(onCellDoubleClick).toHaveBeenCalledTimes(1);
  });
});

// 接线守卫：本缺陷的根因是「同一个附件在三个视图里各写一份渲染」，
// 若有人再在某处手写 `files.map(...).join("、 ")` 或直接 <a href={f.url}>，
// 能力不一致会静默复发（上面所有单测都看不到——它们只测共享组件本身）。
// 故用源码断言锁住三个消费点都走 AttachmentLinks。
describe("三处附件渲染点都接入单一真源 AttachmentLinks", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("网格 CellRenderer / 详情 DetailLayout / 看板画廊 field-controls 均引用同一组件", () => {
    expect(read("./CellRenderer.tsx")).toContain("AttachmentLinks");
    expect(read("../detail/DetailLayout.tsx")).toContain("AttachmentLinks");
    expect(read("../views/field-controls.tsx")).toContain("AttachmentLinks");
  });

  it("网格与详情不得再出现「只拼文件名」的死文本实现", () => {
    // 旧实现：把附件数组 join 成一串名字，看得见拿不到
    expect(read("./CellRenderer.tsx")).not.toContain(".join(\"、 \")");
    // 详情 ReadValue 的数组兜底仍在，但附件必须在它**之前**被拦下并走链接渲染
    const detail = read("../detail/DetailLayout.tsx");
    const at = detail.indexOf('field.type === "attachment"');
    const fallbackAt = detail.indexOf("if (Array.isArray(value))");
    expect(at, "ReadValue 必须有 attachment 分支").toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(at, "attachment 分支必须早于 Array 兜底，否则仍落回 join 死文本").toBeLessThan(fallbackAt);
  });
});

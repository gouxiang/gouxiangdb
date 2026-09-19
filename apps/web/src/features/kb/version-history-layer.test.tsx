// P0-④b 回归：版本历史抽屉必须压住画布常驻工具条。
//
// 原行为（缺陷）：抽屉根是裸 `z-50`，而画布 chrome（drawnix 顶部主工具条 / 缩放条）在
// kb.css:184-188 里固定 75 —— 50 < 75，画布页打开版本历史时被顶部工具条压住。
// 修法：走 z 令牌 gx-z-drawer(400) + createPortal 到 document.body，不许裸数值。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";

// createPortal 在服务端渲染器里不被支持，就地渲染（与 modal-a11y.test.tsx 同一套路）；
// 生产代码不变，portal 目标在浏览器里仍是 document.body。
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (children: unknown) => children };
});

// 抽屉只用这几个 hook 拉版本列表，这里给空数据桩，不发请求、不引 QueryClientProvider。
vi.mock("./kb-hooks", () => ({
  useVersions: () => ({ data: [], isLoading: false }),
  useVersion: () => ({ data: undefined, isLoading: false }),
  useCreateVersion: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRollback: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
// 画布预览与工具条不是本用例的对象，桩掉（Drawnix 是浏览器动态 import，node 下无用）
vi.mock("./DrawnixCanvas", () => ({ DrawnixCanvas: () => null }));
vi.mock("./canvas/CanvasPreviewToolbar", () => ({ CanvasPreviewToolbar: () => null }));
vi.mock("@gx/blocks", () => ({ renderMarkdown: () => "" }));

beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  g.document = g.document ?? { body: {} };
});

import { VersionHistoryDrawer } from "./VersionHistoryDrawer";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const DOC = { id: "d1", title: "架构画布", kind: "canvas" } as never;

describe("版本历史抽屉的层级（P0-④b）", () => {
  it("渲染出来的是 gx-z-drawer 令牌，不是裸 z-50", () => {
    const html = renderToString(
      <VersionHistoryDrawer doc={DOC} canEdit onClose={() => undefined} />,
    );
    expect(html).toContain("版本历史");
    expect(html).toContain("gx-z-drawer");
    expect(html).not.toContain("z-50");
  });

  it("gx-z-drawer 的层级高于画布 chrome（75）", async () => {
    const { zIndex } = await import("@gx/design-tokens");
    expect(zIndex.drawer).toBeGreaterThan(zIndex.canvasChrome);
    // 也不越到应用浮层的弹窗区之上（抽屉 < 弹窗）
    expect(zIndex.drawer).toBeLessThan(zIndex.modal);
  });

  it("portal 到 document.body，且源码里不再出现裸 z 数值", () => {
    const src = read("./VersionHistoryDrawer.tsx");
    expect(src).toContain("createPortal(drawer, document.body)");
    expect(src).toContain('className="fixed inset-0 gx-z-drawer flex justify-end"');
    expect(src).not.toMatch(/className="[^"]*\bz-\d+\b/);
  });
});

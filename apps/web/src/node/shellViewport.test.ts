// shellViewport.ts 单测（node 环境，无 jsdom）：验证仅壳内给 <html> 加视口锁定类，
// 非壳移除、缺 document 不抛。CSS 规则本身见 index.css（类名契约由 SHELL_VIEWPORT_CLASS 锁定）。
import { describe, it, expect, afterEach } from "vitest";
import {
  SHELL_VIEWPORT_CLASS,
  applyShellViewportClass,
  installShellViewport,
  type ViewportDocumentLike,
} from "./shellViewport";

function fakeDoc(): { doc: ViewportDocumentLike; added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  return {
    added,
    removed,
    doc: {
      documentElement: {
        classList: {
          add: (c: string) => added.push(c),
          remove: (c: string) => removed.push(c),
        },
      },
    },
  };
}

describe("applyShellViewportClass", () => {
  it("在壳内：给 <html> 加锁定类（且只加该类）", () => {
    const { doc, added, removed } = fakeDoc();
    applyShellViewportClass(doc, true);
    expect(added).toEqual([SHELL_VIEWPORT_CLASS]);
    expect(removed).toEqual([]);
  });

  it("非壳：移除锁定类（浏览器/fnOS 保持不带类 → CSS 零生效）", () => {
    const { doc, added, removed } = fakeDoc();
    applyShellViewportClass(doc, false);
    expect(removed).toEqual([SHELL_VIEWPORT_CLASS]);
    expect(added).toEqual([]);
  });

  it("类名与 index.css 选择器契约一致（gx-desktop-shell）", () => {
    expect(SHELL_VIEWPORT_CLASS).toBe("gx-desktop-shell");
  });

  it("doc 缺省（null/undefined）时安全返回，不抛错", () => {
    expect(() => applyShellViewportClass(undefined, true)).not.toThrow();
  });
});

describe("installShellViewport", () => {
  const origDocument = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    if (origDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = origDocument;
  });

  it("无 document（SSR/node）时不抛错", () => {
    delete (globalThis as { document?: unknown }).document;
    expect(() => installShellViewport()).not.toThrow();
  });

  it("非壳浏览器（无 __TAURI_INTERNALS__）：不添加、只移除锁定类", () => {
    const { doc, added, removed } = fakeDoc();
    (globalThis as { document?: unknown }).document = doc as unknown as Document;
    installShellViewport();
    expect(added).toEqual([]);
    expect(removed).toEqual([SHELL_VIEWPORT_CLASS]);
  });
});

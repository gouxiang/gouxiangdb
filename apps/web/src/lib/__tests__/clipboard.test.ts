// apps/web/src/lib/__tests__/clipboard.test.ts
// clipboard.ts 三级降级的定向单测。
//
// 范式约束（与本项目既有 lib 测试一致）：apps/web 无 jsdom / happy-dom，vitest 默认
// node 环境，且禁止新增依赖。因此这里不切环境，而是用最小手写假 DOM 覆盖
// globalThis.window / navigator / document，被测代码全部走「typeof x === "undefined"」
// 守卫与标准 DOM 调用，故只需按契约实现这几个成员即可。
//
// 覆盖：
//   1. navigator.clipboard 可用（安全上下文）→ 走路径 1，返回 true；
//   2. navigator.clipboard 为 undefined（模拟局域网 HTTP）→ 走 execCommand 兜底，返回 true；
//   3. 两条路径都失败 → 返回 false 且不抛异常；
//   4. 降级用的 textarea 无论成功失败都从 DOM 摘除（不残留），且还原焦点/选区。
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COPY_FAIL_HINT_LINK, COPY_FAIL_HINT_TEXT, copyText } from "../clipboard";

interface FakeEl {
  tagName: string;
  value: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  contentEditable: string;
  readOnly: boolean;
  childNodes: FakeEl[];
  parentNode: FakeEl | null;
  focusCount: number;
  selectCount: number;
  selection: [number, number] | null;
  setAttribute(k: string, v: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): void;
  focus(): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
}

function makeEl(tagName: string): FakeEl {
  const el: FakeEl = {
    tagName,
    value: "",
    style: {},
    attrs: {},
    contentEditable: "inherit",
    readOnly: false,
    childNodes: [],
    parentNode: null,
    focusCount: 0,
    selectCount: 0,
    selection: null,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
    },
    focus() {
      this.focusCount++;
    },
    select() {
      this.selectCount++;
    },
    setSelectionRange(start, end) {
      this.selection = [start, end];
    },
  };
  return el;
}

interface FakeDoc {
  body: FakeEl;
  activeElement: FakeEl | null;
  created: FakeEl[];
  execCalls: string[];
  execResult: boolean | (() => boolean);
  createElement(tag: string): FakeEl;
  execCommand(cmd: string): boolean;
}

/** 安装假 document；exec 可给常量或抛异常的函数（模拟 execCommand 直接 throw）。 */
function installDoc(exec: boolean | (() => boolean)): FakeDoc {
  const body = makeEl("body");
  const doc: FakeDoc = {
    body,
    activeElement: null,
    created: [],
    execCalls: [],
    execResult: exec,
    createElement(tag) {
      const el = makeEl(tag);
      this.created.push(el);
      return el;
    },
    execCommand(cmd) {
      this.execCalls.push(cmd);
      return typeof this.execResult === "function" ? this.execResult() : this.execResult;
    },
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  return doc;
}

function installWindow(isSecureContext: boolean): void {
  (globalThis as unknown as { window: unknown }).window = { isSecureContext };
}

/** nav 传 undefined 表示「该环境连 navigator 都没有」。 */
function installNavigator(nav: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
}

const NAV_DESC = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  delete g.window;
  delete g.document;
  if (NAV_DESC) Object.defineProperty(globalThis, "navigator", NAV_DESC);
});

describe("copyText 三级降级", () => {
  it("路径 1：安全上下文且 clipboard 可用 → 用异步 API，返回 true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installWindow(true);
    installNavigator({ clipboard: { writeText } });

    const ok = await copyText("https://example.com/s/tok");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("https://example.com/s/tok");
  });

  it("路径 2：HTTP 环境（无 navigator.clipboard）→ 走 execCommand 兜底，返回 true", async () => {
    installWindow(false); // 局域网 HTTP：非安全上下文
    installNavigator({}); // clipboard 缺失
    const doc = installDoc(true);

    const url = "http://192.168.31.167/s/tok";
    const ok = await copyText(url);
    expect(ok).toBe(true);
    expect(doc.execCalls).toEqual(["copy"]);

    // 兜底 textarea 的移动端必备属性
    const ta = doc.created[0];
    expect(ta.tagName).toBe("textarea");
    expect(ta.value).toBe(url);
    expect(ta.contentEditable).toBe("true");
    expect(ta.readOnly).toBe(true);
    expect(ta.attrs.readonly).toBe("");
    expect(ta.style.position).toBe("fixed");
    expect(ta.style.opacity).toBe("0");
    expect(ta.style.fontSize).toBe("16px"); // 防 iOS 聚焦缩放
    // 可见即可选：绝不能用 display:none / visibility:hidden
    expect(ta.style.display).toBeUndefined();
    expect(ta.style.visibility).toBeUndefined();
    expect(ta.selectCount).toBe(1);
    expect(ta.selection).toEqual([0, url.length * 2]);
  });

  it("无 navigator（老环境）也不会抛异常，仍走 execCommand 兜底", async () => {
    installWindow(false);
    installNavigator(undefined);
    const doc = installDoc(true);
    await expect(copyText("abc")).resolves.toBe(true);
    expect(doc.execCalls).toEqual(["copy"]);
  });

  it("路径 3：两条路径都失败 → 返回 false 且不抛异常", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    installWindow(true);
    installNavigator({ clipboard: { writeText } });
    const doc = installDoc(false); // execCommand 返回 false

    await expect(copyText("x")).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(doc.execCalls).toEqual(["copy"]);
    expect(doc.body.childNodes).toHaveLength(0); // 失败也要清理
  });

  it("execCommand 抛异常 → 返回 false 且不向上冒泡", async () => {
    installWindow(false);
    installNavigator({});
    const doc = installDoc(() => {
      throw new Error("execCommand 不可用");
    });

    await expect(copyText("x")).resolves.toBe(false);
    expect(doc.body.childNodes).toHaveLength(0);
  });

  it("降级 textarea 从 DOM 摘除，且焦点与选区被还原", async () => {
    installWindow(false);
    installNavigator({});
    const doc = installDoc(true);
    const anchor = makeEl("input");
    anchor.focus();
    doc.body.appendChild(anchor);
    doc.activeElement = anchor;

    await expect(copyText("http://192.168.31.167/s/tok")).resolves.toBe(true);
    // 只剩原本的 anchor：临时 textarea 已摘除
    expect(doc.body.childNodes).toEqual([anchor]);
    expect(anchor.focusCount).toBe(2); // 自身 1 次 + 还原 1 次
  });

  it("空文本不尝试任何路径，直接返回 false", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installWindow(true);
    installNavigator({ clipboard: { writeText } });
    const doc = installDoc(true);

    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(doc.execCalls).toHaveLength(0);
  });

  it("失败提示文案是明确可执行的（含快捷键）", () => {
    expect(COPY_FAIL_HINT_LINK).toContain("Ctrl/⌘ + C");
    expect(COPY_FAIL_HINT_TEXT).toContain("Ctrl/⌘ + C");
  });
});

describe("全仓收口：不得再有裸 navigator.clipboard 调用", () => {
  const SRC = fileURLToPath(new URL("../../", import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "__tests__" || name === "node_modules") continue; // 测试自身含该字面量（注释），跳过
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it("src 下不得再有裸 writeText 调用（注释里提到 clipboard 不算）", () => {
    // 只匹配真实调用：navigator.clipboard.writeText( / navigator.clipboard?.writeText(
    const CALL = /navigator\.clipboard\??\s*\.\s*writeText\s*\(/;
    // lib/clipboard.ts 是唯一允许出现该 API 的文件（注释中的反例说明也会命中，故排除）
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith("/lib/clipboard.ts"))
      .filter((f) => CALL.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("8 处调用点全部 import 了 copyText", () => {
    // SharePanel.tsx 已删（分享链接管理面板零引用），故从 8 处调用点里去掉。
    const files = [
      "features/kb/ShareModal.tsx",
      "features/contacts/InviteMemberModal.tsx",
      "features/settings/PatTokenModal.tsx",
      "features/kb/WysiwygEditor.tsx",
      "features/search/SearchEnableGuide.tsx",
      "features/designer/FormulaEditorModal.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src, `${f} 未接入 copyText`).toContain("copyText");
      expect(src, `${f} 未从 lib/clipboard 导入`).toMatch(/from "\.\.\/\.\.\/lib\/clipboard"/);
    }
  });
});

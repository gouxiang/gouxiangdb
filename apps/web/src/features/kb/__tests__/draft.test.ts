// apps/web/src/features/kb/__tests__/draft.test.ts
// 本地草稿兜底（draft.ts）契约测试，重点覆盖 P1-2 新增的 sourceUnmerged 标记与
// clearDraftUnlessSourceUnmerged 条件清理。
//
// 环境：本仓 vitest 跑 node、无 jsdom，故用内存 Map 自造 localStorage 并 vi.stubGlobal 注入；
// 不引入任何新依赖。draft.ts 内所有 localStorage 访问都在 try/catch 中，stub 在调用前就位即可。
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  saveDraft,
  loadDraft,
  clearDraftUnlessSourceUnmerged,
  hasRecoverableDraft,
} from "../draft";

const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", localStorageMock);
});

describe("saveDraft / loadDraft：sourceUnmerged 标记透传与同 key 覆盖解除", () => {
  it("带 sourceUnmerged 的草稿可被原样读回（含标记字段）", () => {
    saveDraft("d1", { content: "src-edit", baseContent: "BASE", sourceUnmerged: true });
    expect(loadDraft("d1")).toEqual({
      content: "src-edit",
      baseContent: "BASE",
      savedAt: expect.any(Number),
      sourceUnmerged: true,
    });
  });

  it("普通草稿不带 sourceUnmerged 字段", () => {
    saveDraft("d2", { content: "plain-edit", baseContent: "BASE" });
    const d = loadDraft("d2");
    expect(d).not.toBeNull();
    expect(d).not.toHaveProperty("sourceUnmerged");
  });

  it("同 key 再次写入不带标记的草稿即自然解除 sourceUnmerged", () => {
    saveDraft("d3", { content: "src-edit", baseContent: "BASE", sourceUnmerged: true });
    expect(loadDraft("d3")?.sourceUnmerged).toBe(true);
    // 非 source 的 markDirty 以同 key 覆盖（如切回所见即所得后 Y 回放写入普通草稿）
    saveDraft("d3", { content: "merged-edit", baseContent: "BASE" });
    const d = loadDraft("d3");
    expect(d?.content).toBe("merged-edit");
    expect(d).not.toHaveProperty("sourceUnmerged");
  });

  it("content 与 baseContent 一致时 saveDraft 直接清草稿（既有短路不变）", () => {
    saveDraft("d4", { content: "SAME", baseContent: "SAME", sourceUnmerged: true });
    expect(loadDraft("d4")).toBeNull();
  });
});

describe("clearDraftUnlessSourceUnmerged（P1-2 条件清理，两分支）", () => {
  it("带 sourceUnmerged 标记 → 保留草稿并返回 false", () => {
    saveDraft("d1", { content: "src-edit", baseContent: "BASE", sourceUnmerged: true });
    const cleared = clearDraftUnlessSourceUnmerged("d1");
    expect(cleared).toBe(false);
    expect(loadDraft("d1")).not.toBeNull(); // 草稿仍在，恢复入口保留
  });

  it("普通草稿（无标记）→ 清除并返回 true", () => {
    saveDraft("d2", { content: "plain-edit", baseContent: "BASE" });
    const cleared = clearDraftUnlessSourceUnmerged("d2");
    expect(cleared).toBe(true);
    expect(loadDraft("d2")).toBeNull();
  });

  it("本就没有草稿 → 返回 true（与 clearDraft 等价，无副作用）", () => {
    expect(clearDraftUnlessSourceUnmerged("absent")).toBe(true);
  });

  it("被保留的 sourceUnmerged 草稿在解除标记后可被正常清除", () => {
    saveDraft("d3", { content: "src-edit", baseContent: "BASE", sourceUnmerged: true });
    expect(clearDraftUnlessSourceUnmerged("d3")).toBe(false); // 先保留
    saveDraft("d3", { content: "merged-edit", baseContent: "BASE" }); // 同 key 解除标记
    expect(clearDraftUnlessSourceUnmerged("d3")).toBe(true); // 再清理即清除
    expect(loadDraft("d3")).toBeNull();
  });
});

describe("hasRecoverableDraft 对带标记草稿仍按既有差异口径判定", () => {
  it("带 sourceUnmerged 且与服务端有差异 → 可恢复（保留标记）", () => {
    saveDraft("d1", { content: "src-edit", baseContent: "BASE", sourceUnmerged: true });
    expect(hasRecoverableDraft("d1", "BASE")).toMatchObject({ sourceUnmerged: true });
  });

  it("草稿内容与服务端一致 → 不可恢复（既有短路不变，即使带标记）", () => {
    // 直接写一份 content===serverContent 的持久化草稿（绕过 saveDraft 的相等即清短路），
    // 验证 hasRecoverableDraft 自身的同文短路对带标记草稿同样生效。
    store.set(
      "gx-kb-draft:d2",
      JSON.stringify({ content: "SAME", baseContent: "SAME", savedAt: 1, sourceUnmerged: true }),
    );
    expect(hasRecoverableDraft("d2", "SAME")).toBeNull();
  });
});

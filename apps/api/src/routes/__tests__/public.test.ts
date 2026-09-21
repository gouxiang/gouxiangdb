// apps/api/src/routes/__tests__/public.test.ts
// 公开分享「引用闭包」接口 GET /s/:token/ref/:docId 单测。
// 使用内存 fake prisma（不触碰真实 SQLite），直接调 Hono 实例 pub.request。
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- 内存文档夹具类型（仅列出 public.ts 实际用到的字段） ----
interface FakeDoc {
  id: string;
  kbId: string;
  kind: "doc" | "canvas";
  title: string;
  content: string;
  parentId: string | null;
  updatedAt: Date;
  shareEnabled: boolean;
  shareToken: string | null;
  shareRole: string;
  shareIncludeChildren: boolean;
  /** 测试夹具内部标记，模拟真实 where 中的 deletedAt:null 过滤 */
  deletedAtMark?: boolean;
}

function doc(p: Partial<FakeDoc> & Pick<FakeDoc, "id" | "kind">): FakeDoc {
  return {
    kbId: "kb1",
    title: p.id ?? "untitled",
    content: "",
    parentId: null,
    updatedAt: new Date("2026-09-10T00:00:00.000Z"),
    shareEnabled: false,
    shareToken: null,
    shareRole: "viewer",
    shareIncludeChildren: false,
    ...p,
  };
}

/** 构造一段画布 content，引用若干 docId（支持 gxDocRef / gxLinkRef，且深度嵌套） */
function canvasJson(...refs: Array<{ key: "gxDocRef" | "gxLinkRef"; docId: string }>): string {
  return JSON.stringify(
    refs.map((r, i) => ({
      id: `el-${i}`,
      type: "geometry",
      points: [[0, 0]],
      // 刻意再嵌一层对象 / 数组，验证递归遍历
      children: [{ nested: { [r.key]: { docId: r.docId, title: `ref-${r.docId}` } } }],
    })),
  );
}

// ---- fake prisma ----
let docs: FakeDoc[] = [];

vi.mock("../../db.js", () => ({
  prisma: {
    kbDoc: {
      // findShareRoot（where 带 shareToken）与目标文档查询（where 带 id）共用
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        if ("shareToken" in where) {
          const hit = docs.find(
            (d) =>
              d.shareToken === where.shareToken &&
              d.shareEnabled === true &&
              d.deletedAtMark !== true,
          );
          return Promise.resolve(hit ? { ...hit } : null);
        }
        const id = where.id as string;
        const hit = docs.find((d) => d.id === id && d.deletedAtMark !== true);
        return Promise.resolve(hit ? { ...hit } : null);
      },
      findMany: ({ where }: { where: Record<string, unknown> }) => {
        // subtreeIdSet：全表 id/parentId
        if (!("id" in where)) {
          return Promise.resolve(docs.map((d) => ({ id: d.id, parentId: d.parentId })));
        }
        // 闭包展开：仅取集合内 kind=canvas 的 id/content
        const ids = (where.id as { in: string[] }).in as string[];
        return Promise.resolve(
          docs
            .filter((d) => ids.includes(d.id) && d.kind === "canvas" && d.deletedAtMark !== true)
            .map((d) => ({ id: d.id, content: d.content })),
        );
      },
    },
  },
}));

// mock 必须在 import 被测模块前就位（vi.mock 会提升）
const { pub, collectRefDocIds, buildShareReferenceClosure } = await import("../public.js");

async function getRef(token: string, docId: string) {
  const res = await pub.request(`/s/${token}/ref/${docId}`, { method: "GET" });
  const body = (await res.json().catch(() => ({}))) as {
    doc?: { id: string; kind: string; title: string; content: string; canEdit: boolean };
    canEdit?: boolean;
    shareRole?: string;
    error?: string;
  };
  return { status: res.status, body };
}

describe("GET /s/:token/ref/:docId 引用闭包授权", () => {
  beforeEach(() => {
    docs = [];
  });

  it("画布 gxDocRef 指向子树外文档：viewer 根 → 200 且 canEdit=false", async () => {
    docs = [
      doc({
        id: "R",
        kind: "canvas",
        shareEnabled: true,
        shareToken: "tok-ref",
        shareRole: "viewer",
        content: canvasJson({ key: "gxDocRef", docId: "X" }),
      }),
      doc({ id: "X", kind: "doc", title: "外部文档", parentId: "elsewhere" }),
    ];
    const r = await getRef("tok-ref", "X");
    expect(r.status).toBe(200);
    expect(r.body.doc?.id).toBe("X");
    expect(r.body.canEdit).toBe(false);
    expect(r.body.shareRole).toBe("viewer");
  });

  it("editor 根经引用闭包访问子树外文档：仍只读 canEdit=false", async () => {
    docs = [
      doc({
        id: "R",
        kind: "canvas",
        shareEnabled: true,
        shareToken: "tok-editor",
        shareRole: "editor",
        content: canvasJson({ key: "gxLinkRef", docId: "X" }),
      }),
      doc({ id: "X", kind: "doc", parentId: "elsewhere" }),
    ];
    const r = await getRef("tok-editor", "X");
    expect(r.status).toBe(200);
    expect(r.body.canEdit).toBe(false);
  });

  // 产品口径变更（权限核心模型二）：分享链接对外一律只读，可编辑性不再跟随 shareRole。
  it("目标在文档子树内：即便 shareRole=editor，引用闭包也恒 canEdit=false（对外只读）", async () => {
    docs = [
      doc({
        id: "R",
        kind: "doc",
        shareEnabled: true,
        shareToken: "tok-sub",
        shareRole: "editor",
        shareIncludeChildren: true,
      }),
      doc({ id: "CHILD", kind: "doc", parentId: "R" }),
    ];
    const r = await getRef("tok-sub", "CHILD");
    expect(r.status).toBe(200);
    expect(r.body.canEdit).toBe(false);
  });

  it("未被任何已授权画布引用的 id → 403", async () => {
    docs = [
      doc({
        id: "R",
        kind: "canvas",
        shareEnabled: true,
        shareToken: "tok-403",
        shareRole: "viewer",
        content: canvasJson({ key: "gxDocRef", docId: "X" }),
      }),
      doc({ id: "X", kind: "doc" }),
      doc({ id: "Y", kind: "doc" }), // 存在但无人引用
    ];
    const r = await getRef("tok-403", "Y");
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("分享范围");
  });

  it("引用链深度 2（A 画布→B 画布→普通文档 C）：C 可取", async () => {
    docs = [
      doc({
        id: "A",
        kind: "canvas",
        shareEnabled: true,
        shareToken: "tok-chain",
        shareRole: "viewer",
        content: canvasJson({ key: "gxDocRef", docId: "B" }),
      }),
      doc({ id: "B", kind: "canvas", content: canvasJson({ key: "gxLinkRef", docId: "C" }) }),
      doc({ id: "C", kind: "doc", title: "第三层文档" }),
    ];
    const r = await getRef("tok-chain", "C");
    expect(r.status).toBe(200);
    expect(r.body.doc?.id).toBe("C");
    expect(r.body.canEdit).toBe(false);
  });

  it("深度上限：第 4 层文档（A→B→D 画布→E）→ 403", async () => {
    docs = [
      doc({
        id: "A",
        kind: "canvas",
        shareEnabled: true,
        shareToken: "tok-deep",
        shareRole: "viewer",
        content: canvasJson({ key: "gxDocRef", docId: "B" }),
      }),
      // B（第 2 层）同时引 C（第 3 层普通文档）与 D（第 3 层画布）
      doc({
        id: "B",
        kind: "canvas",
        content: JSON.stringify({
          children: [
            { gxDocRef: { docId: "C" } },
            { gxDocRef: { docId: "D" } },
          ],
        }),
      }),
      doc({ id: "C", kind: "doc" }),
      doc({ id: "D", kind: "canvas", content: canvasJson({ key: "gxDocRef", docId: "E" }) }),
      doc({ id: "E", kind: "doc" }), // 第 4 层：D 已无展开机会
    ];
    const c = await getRef("tok-deep", "C");
    expect(c.status).toBe(200);
    const d = await getRef("tok-deep", "D");
    expect(d.status).toBe(200); // 第 3 层画布本身仍在闭包内
    const e = await getRef("tok-deep", "E");
    expect(e.status).toBe(403);
  });

  it("环引用（A 引 B、B 引 A）不卡死，B 可取", async () => {
    docs = [
      doc({
        id: "A",
        kind: "canvas",
        shareEnabled: true,
        shareToken: "tok-cycle",
        shareRole: "viewer",
        content: canvasJson({ key: "gxDocRef", docId: "B" }),
      }),
      doc({ id: "B", kind: "canvas", content: canvasJson({ key: "gxDocRef", docId: "A" }) }),
    ];
    const r = await getRef("tok-cycle", "B");
    expect(r.status).toBe(200);
    expect(r.body.doc?.id).toBe("B");
  });

  it("失效 token → 404（沿用现有语义）", async () => {
    docs = [doc({ id: "R", kind: "canvas", shareEnabled: true, shareToken: "tok-ok" })];
    const r = await getRef("wrong-token", "R");
    expect(r.status).toBe(404);
  });

  it("闭包命中授权但目标文档不存在 → 404", async () => {
    docs = [
      doc({
        id: "R",
        kind: "canvas",
        shareEnabled: true,
        shareToken: "tok-missing",
        shareRole: "viewer",
        content: canvasJson({ key: "gxDocRef", docId: "GONE" }),
      }),
      // GONE 不在库中：授权闭包包含 id（来自画布 JSON），但 findFirst 查不到
    ];
    const r = await getRef("tok-missing", "GONE");
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("不存在或已被删除");
  });
});

describe("collectRefDocIds 容错", () => {
  it("收集 gxDocRef / gxLinkRef，去重，忽略非字符串 docId", () => {
    const ids = collectRefDocIds(
      JSON.stringify([
        { gxDocRef: { docId: "1" } },
        { gxLinkRef: { docId: "2" } },
        { gxDocRef: { docId: "1" } }, // 重复
        { gxDocRef: { docId: 123 } }, // 非字符串
        { gxDocRef: {} }, // 缺字段
        { gxDocRef: null },
        { deep: [[{ gxLinkRef: { docId: "3" } }]] },
      ]),
    );
    expect([...ids].sort()).toEqual(["1", "2", "3"]);
  });

  it("坏 JSON / 非对象根 / 环引用均安全", () => {
    expect(collectRefDocIds("not-json{").size).toBe(0);
    expect(collectRefDocIds('"a plain string"').size).toBe(0);
    const cyclic: Record<string, unknown> = { gxDocRef: { docId: "X" } };
    cyclic.self = cyclic; // 对象环
    expect(collectRefDocIds(JSON.stringify({ a: 1 })).size).toBe(0);
    // JSON.stringify 无法序列化环；直接验证 walk 不依赖此点，改用普通重复引用
    const shared = { gxDocRef: { docId: "Y" } };
    const ids = collectRefDocIds(JSON.stringify({ x: shared, z: [shared, shared] }));
    expect([...ids]).toEqual(["Y"]);
    void cyclic;
  });
});

// ============ 旧格式 token 兼容（红线） ============
//
// genShareToken 由 hex(24B→48 字符) 改为 base64url(24B→32 字符) 后，历史上已发出的
// 48 字符 hex 分享链接必须照常可打开。public.ts 的 findShareRoot 按 shareToken 等值查库，
// 对 token 的长度/字符集无任何假设——本组用例把这条不变式钉死。

/** 旧格式：24 字节 hex，48 字符（改动前的生成形态） */
const LEGACY_HEX_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
/** 新格式：24 字节 base64url，32 字符，含 - 与 _ 两个 URL-safe 特殊符号 */
const NEW_B64_TOKEN = "abcDEF0123456789-_abcDEF01234567";

async function getRoot(token: string) {
  const res = await pub.request(`/s/${token}`, { method: "GET" });
  const body = (await res.json().catch(() => ({}))) as {
    rootToken?: string;
    doc?: { id: string; title: string };
    error?: string;
  };
  return { status: res.status, body };
}

describe("分享 token 编码切换的向后兼容（旧 48 位 hex 链接必须继续可用）", () => {
  beforeEach(() => {
    docs = [];
  });

  it("夹具形态自检：旧 token 是 48 位 hex、新 token 是 32 位 base64url", () => {
    expect(LEGACY_HEX_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(NEW_B64_TOKEN).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("旧 48 位 hex token → 200，命中其所属文档", async () => {
    docs = [
      doc({ id: "OLD", kind: "doc", title: "旧链接文档", shareEnabled: true, shareToken: LEGACY_HEX_TOKEN }),
    ];
    const r = await getRoot(LEGACY_HEX_TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.doc?.id).toBe("OLD");
    expect(r.body.rootToken).toBe(LEGACY_HEX_TOKEN);
  });

  it("新 32 位 base64url token（含 - 与 _）→ 200，路径解析不被转义破坏", async () => {
    docs = [
      doc({ id: "NEW", kind: "doc", title: "新链接文档", shareEnabled: true, shareToken: NEW_B64_TOKEN }),
    ];
    const r = await getRoot(NEW_B64_TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.doc?.id).toBe("NEW");
    expect(r.body.rootToken).toBe(NEW_B64_TOKEN);
  });

  it("新旧两种格式 token 在同一库共存，各自解析到自己的文档（互不串味）", async () => {
    docs = [
      doc({ id: "OLD", kind: "doc", title: "旧链接文档", shareEnabled: true, shareToken: LEGACY_HEX_TOKEN }),
      doc({ id: "NEW", kind: "doc", title: "新链接文档", shareEnabled: true, shareToken: NEW_B64_TOKEN }),
    ];
    const a = await getRoot(LEGACY_HEX_TOKEN);
    const b = await getRoot(NEW_B64_TOKEN);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.doc?.id).toBe("OLD");
    expect(b.body.doc?.id).toBe("NEW");
  });

  it("旧 token 走子文档路径 /s/:token/doc/:docId 同样可用（级联分享）", async () => {
    docs = [
      doc({
        id: "OLDROOT",
        kind: "doc",
        shareEnabled: true,
        shareToken: LEGACY_HEX_TOKEN,
        shareIncludeChildren: true,
      }),
      doc({ id: "OLDCHILD", kind: "doc", title: "子文档", parentId: "OLDROOT" }),
    ];
    const res = await pub.request(`/s/${LEGACY_HEX_TOKEN}/doc/OLDCHILD`, { method: "GET" });
    const body = (await res.json().catch(() => ({}))) as { doc?: { id: string } };
    expect(res.status).toBe(200);
    expect(body.doc?.id).toBe("OLDCHILD");
  });

  it("旧 token 但分享已关闭 → 404（吊销语义不变，与编码无关）", async () => {
    docs = [
      doc({ id: "OLD", kind: "doc", shareEnabled: false, shareToken: LEGACY_HEX_TOKEN }),
    ];
    const r = await getRoot(LEGACY_HEX_TOKEN);
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("失效");
  });
});

describe("buildShareReferenceClosure 直接覆盖", () => {
  beforeEach(() => {
    docs = [];
  });

  it("返回集合包含根与各层引用，受深度限制", async () => {
    docs = [
      doc({ id: "A", kind: "canvas", content: canvasJson({ key: "gxDocRef", docId: "B" }) }),
      doc({ id: "B", kind: "canvas", content: canvasJson({ key: "gxDocRef", docId: "C" }) }),
      doc({ id: "C", kind: "doc" }),
    ];
    const closure = await buildShareReferenceClosure({
      id: "A",
      kind: "canvas",
      shareIncludeChildren: false,
    });
    expect([...closure].sort()).toEqual(["A", "B", "C"]);
  });

  it("shareIncludeChildren 时并入子树", async () => {
    docs = [
      doc({ id: "A", kind: "canvas", shareIncludeChildren: true }),
      doc({ id: "K1", kind: "doc", parentId: "A" }),
      doc({ id: "K2", kind: "doc", parentId: "K1" }),
    ];
    const closure = await buildShareReferenceClosure({
      id: "A",
      kind: "canvas",
      shareIncludeChildren: true,
    });
    expect([...closure].sort()).toEqual(["A", "K1", "K2"]);
  });
});

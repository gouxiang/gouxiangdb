// apps/api/src/routes/__tests__/help-proxy.test.ts
// 帮助百科代理路由契约：vi.spyOn(globalThis,"fetch") mock Gitea 上游，不真实出网。
// 默认 config（无 GX_GITEA_TOKEN）走匿名 HTML 侧边栏解析；token 路径用纯函数 fetchWikiPages 直测。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchWikiPages,
  helpProxy,
  parseWikiSidebar,
  rewriteWikiImageLinks,
  validateAssetPath,
  __resetHelpProxyCacheForTest,
} from "../helpProxy.js";

const WIKI_BASE = "https://gitea0.hn.takin.cc/GouXiang/gouxiangdb";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("rewriteWikiImageLinks 纯函数", () => {
  it("改写 markdown/HTML 相对图片，不动绝对/data/根路径", () => {
    const md = [
      "![网格](images/tour/02-grid.png)",
      "| a | ![](images/x.jpg \"标题\") |",
      '<img src="images/y.svg" alt="t">',
      "![外链](https://x.com/a.png)",
      "![data](data:image/png;base64,AAAA)",
      "![根](/images/z.png)",
    ].join("\n");
    const out = rewriteWikiImageLinks(md);
    expect(out).toContain(`](/api/help/asset?path=${encodeURIComponent("images/tour/02-grid.png")})`);
    expect(out).toContain(`](/api/help/asset?path=${encodeURIComponent("images/x.jpg")} "标题")`);
    expect(out).toContain(`src="/api/help/asset?path=${encodeURIComponent("images/y.svg")}"`);
    expect(out).toContain("![外链](https://x.com/a.png)");
    expect(out).toContain("![data](data:image/png;base64,AAAA)");
    expect(out).toContain("![根](/images/z.png)");
    expect(out).not.toContain("](images/");
    expect(out).not.toContain('src="images/');
  });
});

describe("validateAssetPath 纯函数", () => {
  it.each([
    ["images/tour/02-grid.png", "images/tour/02-grid.png"],
    ["images/a.JPG", "images/a.JPG"],
    ["images/sub/b.svg", "images/sub/b.svg"],
  ])("合法：%s", (input, expected) => {
    expect(validateAssetPath(input)).toBe(expected);
  });

  it.each([
    ["../etc/passwd.png"],
    ["images/../x.png"],
    ["images/a/../../b.png"],
    ["/images/x.png"],
    ["etc/x.png"],
    ["images/x.exe"],
    ["images/x"],
    ["images/x.png\\y"],
    ["images/a\0b.png"],
    [""],
    [null],
  ])("非法：%s", (input) => {
    expect(validateAssetPath(input)).toBeNull();
  });
});

describe("parseWikiSidebar 纯函数", () => {
  it("解析侧边栏链接、解码中文标题、去重、Home 置顶，排除 action/raw/锚点", () => {
    const html = [
      '<a href="/GouXiang/gouxiangdb/wiki/raw/Home">raw</a>',
      '<a href="/GouXiang/gouxiangdb/wiki?action=pages">pages</a>',
      '<a href="/GouXiang/gouxiangdb/wiki/%E6%95%B0%E6%8D%AE%E5%BA%93%E5%85%A5%E9%97%A8">数据库入门</a>',
      '<a href="/GouXiang/gouxiangdb/wiki/%E6%95%B0%E6%8D%AE%E5%BA%93%E5%85%A5%E9%97%A8#sec">重复带锚</a>',
      `<a href='${WIKI_BASE}/wiki'>首页</a>`,
      '<a href="/GouXiang/gouxiangdb/wiki/Platform">Platform</a>',
    ].join("\n");
    const pages = parseWikiSidebar(html, "GouXiang", "gouxiangdb");
    expect(pages[0]).toEqual({ title: "Home", href: "Home" });
    expect(pages).toContainEqual({ title: "数据库入门", href: "数据库入门" });
    expect(pages).toContainEqual({ title: "Platform", href: "Platform" });
    // 去重：数据库入门只出现一次
    expect(pages.filter((p) => p.title === "数据库入门")).toHaveLength(1);
  });

  it("排除 wiki 图片/二进制附件（images/ 前缀与扩展名），不把附件当页面", () => {
    const html = [
      '<a href="/o/r/wiki/images/tour/02-grid.png">02-grid</a>',
      '<a href="/o/r/wiki/images/tour/02-grid.png?raw=true">带参图片</a>',
      '<a href="/o/r/wiki/images%2Ftour%2F03-kanban.png">编码图片</a>',
      '<a href="/o/r/wiki/attachments/a.zip">zip</a>',
      '<a href="/o/r/wiki/photo.JPG">大写图片扩展名</a>',
      '<a href="/o/r/wiki/产品介绍">正常页</a>',
      '<a href="/o/r/wiki/无扩展名标题">无扩展名标题保留</a>',
    ].join("\n");
    const pages = parseWikiSidebar(html, "o", "r");
    const titles = pages.map((p) => p.title);
    expect(titles).toContain("产品介绍");
    expect(titles).toContain("无扩展名标题");
    expect(titles.some((t) => t.includes(".png"))).toBe(false);
    expect(titles.some((t) => t.startsWith("images/"))).toBe(false);
    expect(titles).not.toContain("attachments/a.zip");
    expect(titles).not.toContain("photo.JPG");
  });
});

describe("GET /api/help/wiki", () => {
  beforeEach(() => {
    __resetHelpProxyCacheForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("① 成功：返回原文改写后的 markdown、imageBase、侧边栏 pages、60s 缓存", async () => {
    const markdown = "# 首页\n\n![网格](images/tour/02-grid.png)\n";
    const sidebarHtml =
      '<a href="/GouXiang/gouxiangdb/wiki">Home</a>' +
      '<a href="/GouXiang/gouxiangdb/wiki/Tour">Tour</a>';
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u === `${WIKI_BASE}/wiki/raw/Home`) {
        return new Response(markdown, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Last-Modified": "Mon, 19 Oct 2026 01:02:03 GMT" },
        });
      }
      if (u === `${WIKI_BASE}/wiki`) {
        return new Response(sidebarHtml, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      return jsonResponse({ message: "unexpected" }, { status: 404 });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const res = await helpProxy.request("/wiki");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.page).toBe("Home");
    expect(body.home).toBe("Home");
    expect(body.imageBase).toBe("/api/help/asset?path=");
    expect(body.markdown).toContain(
      `/api/help/asset?path=${encodeURIComponent("images/tour/02-grid.png")}`,
    );
    expect(body.markdown).not.toContain("](images/");
    expect(body.pages).toContainEqual({ title: "Home", href: "Home" });
    expect(body.pages).toContainEqual({ title: "Tour", href: "Tour" });
    expect(body.updatedAt).toBe("Mon, 19 Oct 2026 01:02:03 GMT");

    // 第二跳目录请求确实是匿名 HTML（无 Authorization 头）。
    const sidebarCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === `${WIKI_BASE}/wiki`,
    );
    expect(sidebarCall).toBeTruthy();
    const sidebarInit = (sidebarCall?.[1] ?? {}) as RequestInit;
    expect(sidebarInit.headers ?? {}).not.toHaveProperty("Authorization");
  });

  it("②a 上游 500 -> 502 WIKI_UNREACHABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("boom", { status: 500 }),
    );    const res = await helpProxy.request("/wiki?page=Tour");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "WIKI_UNREACHABLE" });
  });

  it("②b 上游超时/断连（fetch reject）-> 502 WIKI_UNREACHABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const res = await helpProxy.request("/wiki");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "WIKI_UNREACHABLE" });
  });

  it("③ 目录 HTML 获取失败时正文照常返回，pages 降级为至少 Home", async () => {
    const markdown = "# x";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === `${WIKI_BASE}/wiki/raw/Home`) return new Response(markdown, { status: 200 });
      return new Response("err", { status: 502 });
    });
    const res = await helpProxy.request("/wiki");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.markdown).toBe(markdown);
    expect(body.pages).toEqual([{ title: "Home", href: "Home" }]);
  });
});

describe("GET /api/help/asset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("④ 正常透传：按上游 content-type 返回图片，带 1h 缓存", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${WIKI_BASE}/wiki/raw/images/tour/02-grid.png`);
      return new Response(pngBytes, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "8" },
      });
    });
    const res = await helpProxy.request(
      `/asset?path=${encodeURIComponent("images/tour/02-grid.png")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(pngBytes);
  });

  it("④b SVG 上游给 text/html 也强制透传为 image/svg+xml", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("<svg></svg>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    const res = await helpProxy.request(`/asset?path=${encodeURIComponent("images/d.svg")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("④c 上游 404 -> 502", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("nope", { status: 404 }),
    );
    const res = await helpProxy.request(`/asset?path=${encodeURIComponent("images/missing.png")}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "WIKI_UNREACHABLE" });
  });

  it.each([
    ["../secret.png"],
    ["images/../../x.png"],
    ["static/x.png"],
    ["/images/x.png"],
    ["images/x.exe"],
    [""],
  ])("⑤ 非法路径 400 且不触发出站：%s", async (bad) => {
    const fetchMock = vi.fn(async () => new Response("x", { status: 200 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
    const res = await helpProxy.request(`/asset?path=${encodeURIComponent(bad)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: "BAD_ASSET_PATH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchWikiPages token 路径", () => {
  afterEach(() => vi.restoreAllMocks());

  const tokenSettings = {
    wikiBase: WIKI_BASE,
    apiBase: "https://gitea0.hn.takin.cc/api/v1",
    token: "pat-readonly",
    owner: "GouXiang",
    repo: "gouxiangdb",
  };

  it("有 token：调 /repos/<owner>/<repo>/wiki/pages 带 Authorization，解析 title", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) =>
      jsonResponse([{ title: "Home" }, { title: "Tour" }, { title: "数据库入门" }]),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
    const pages = await fetchWikiPages(tokenSettings);
    expect(pages).toEqual([
      { title: "Home", href: "Home" },
      { title: "Tour", href: "Tour" },
      { title: "数据库入门", href: "数据库入门" },
    ]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
    expect(url).toBe("https://gitea0.hn.takin.cc/api/v1/repos/GouXiang/gouxiangdb/wiki/pages");
    expect((init.headers as Record<string, string>).Authorization).toBe("token pat-readonly");
  });

  it("API 500 时抛错（调用方 getPages 负责降级含 Home）", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("err", { status: 500 }),
    );
    await expect(fetchWikiPages(tokenSettings)).rejects.toThrow(/500/);
  });
});

// scripts/release/__tests__/lib-gitea.test.mjs
// Gitea 客户端薄封装：用注入的 fetch 桩验证
//   - 令牌只走 Authorization 头（不进 query）；
//   - 错误净化（不回显响应体内网 URL）；
//   - getReleaseByTag 404 -> null（幂等）；其它状态抛 GiteaApiError；
//   - 资产直链由固定路径自拼，不使用 API 返回的 browser_download_url。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGiteaClient, GiteaApiError } from "../lib-gitea.mjs";

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchImpl) {
  return createGiteaClient({
    baseUrl: "https://gitea.example/",
    token: "secret-token",
    owner: "GouXiang",
    repo: "gouxiangdb",
    fetchImpl,
  });
}

test("构造参数缺失即拒绝（令牌不来自命令行）", () => {
  assert.throws(() => createGiteaClient({ baseUrl: "x", token: "", owner: "o", repo: "r" }), /token/);
  assert.throws(() => createGiteaClient({ baseUrl: "x", token: "t", owner: "", repo: "r" }), /owner/);
});

test("getReleaseByTag：200 返回 release，且令牌只在 Authorization 头", async () => {
  const { fetchImpl, calls } = mockFetch(async (url) => {
    assert.ok(url.includes("/repos/GouXiang/gouxiangdb/releases/tags/v0.2.3"));
    assert.ok(!url.includes("access_token"), "令牌不得进 query");
    return jsonRes(200, { id: 9, tag_name: "v0.2.3" });
  });
  const c = makeClient(fetchImpl);
  const rel = await c.getReleaseByTag("v0.2.3");
  assert.equal(rel.id, 9);
  assert.equal(calls[0].init.headers.Authorization, "token secret-token");
});

test("getReleaseByTag：404 返回 null（发布幂等判断），不抛错", async () => {
  const { fetchImpl } = mockFetch(async () => jsonRes(404, { message: "Not Found" }));
  const c = makeClient(fetchImpl);
  assert.equal(await c.getReleaseByTag("v0.2.3"), null);
});

test("错误净化：403 错误消息不含响应体里的内网 URL", async () => {
  const leakBody = {
    message: "user does not have permission",
    url: "http://192.168.31.88:21350/swagger#/repository/createRelease",
  };
  const { fetchImpl } = mockFetch(async () => jsonRes(403, leakBody));
  const c = makeClient(fetchImpl);
  await assert.rejects(
    () => c.createRelease({ tag_name: "v0.2.3" }),
    (e) => {
      assert.ok(e instanceof GiteaApiError);
      assert.equal(e.status, 403);
      assert.ok(!String(e.message).includes("192.168.31.88"), "错误消息泄漏内网 URL");
      assert.ok(e.message.includes("permission"));
      return true;
    },
  );
});

test("网络层失败收口为 GiteaApiError(0)，不带完整 URL", async () => {
  const { fetchImpl } = mockFetch(async () => {
    throw new TypeError("fetch failed");
  });
  const c = makeClient(fetchImpl);
  await assert.rejects(
    () => c.listAssets(1),
    (e) => e instanceof GiteaApiError && e.status === 0 && e.message.includes("网络不可达"),
  );
});

test("assetDownloadUrl：按固定路径自拼，忽略 API 返回字段", () => {
  const c = makeClient(mockFetch(() => null).fetchImpl);
  const url = c.assetDownloadUrl("v0.2.3", "gouxiangdb-0.2.3-x86.fpk");
  assert.equal(
    url,
    "https://gitea.example/GouXiang/gouxiangdb/releases/download/v0.2.3/gouxiangdb-0.2.3-x86.fpk",
  );
});

test("uploadAsset：multipart 表单，不手设 Content-Type，query 带 name", async () => {
  const { fetchImpl, calls } = mockFetch(async () => jsonRes(201, { id: 1, name: "a.fpk" }));
  const c = makeClient(fetchImpl);
  await c.uploadAsset(9, "a.fpk", Buffer.from("hello"));
  const { url, init } = calls[0];
  assert.ok(url.includes("/releases/9/assets?name=a.fpk"));
  // FormData 由 fetch 生成 multipart 边界：调用方不得手设 Content-Type
  assert.equal("Content-Type" in init.headers, false);
  assert.equal("content-type" in init.headers, false);
  assert.ok(init.body instanceof FormData);
  assert.equal(init.headers.Authorization, "token secret-token");
});

test("headReleaseAsset：非 2xx 抛净化错误", async () => {
  const { fetchImpl } = mockFetch(async () => new Response(null, { status: 401 }));
  const c = makeClient(fetchImpl);
  await assert.rejects(() => c.headReleaseAsset("v0.2.3", "a.fpk"), GiteaApiError);
});

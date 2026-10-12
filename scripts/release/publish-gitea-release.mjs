#!/usr/bin/env node
// scripts/release/publish-gitea-release.mjs
// 主编排（DESIGN §8.2 伪代码）：版本断言 → fpk 实算 artifact → 合并旧清单 →
// 幂等建 release → 同名资产先删后传（fpk + update-manifest.json）→ 回读校验 → 脱敏摘要。
//
// 用法：
//   GX_GITEA_TOKEN=<写令牌> node scripts/release/publish-gitea-release.mjs \
//     --tag v0.2.3 [--prerelease] [--draft] [--min-version 0.1.0] \
//     [--dist deploy/fnos/dist] [--notes docs/release-notes/0.2.3.md]
//
// 令牌纪律：只从 env GX_GITEA_TOKEN 读取（不接受命令行参数）；绝不打印 API 返回的
// browser_download_url（实测是内网地址）；错误只输出净化后的 GiteaApiError 消息。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGiteaClient } from "./lib-gitea.mjs";
import {
  artifactsFromFiles,
  buildManifest,
  parseFpkFilename,
  readNotes,
} from "./build-manifest.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DEFAULT_BASE_URL = process.env.GX_GITEA_BASE_URL || "https://gitea0.hn.takin.cc";
const OWNER = process.env.GX_GITEA_OWNER || "GouXiang";
const REPO = process.env.GX_GITEA_REPO || "gouxiangdb";
const MANIFEST_ASSET = "update-manifest.json";

function usage() {
  console.error(
    [
      "用法：GX_GITEA_TOKEN=<写令牌> node scripts/release/publish-gitea-release.mjs",
      "  --tag v0.2.3            必填，形如 vX.Y.Z",
      "  --prerelease            标记预发布（如 v0.2.3-rc1；客户端默认不可见）",
      "  --draft                 创建草稿 release",
      "  --min-version 0.1.0     声明最低可直升版本（缺省取旧清单最新 release 的 minVersion）",
      "  --dist <dir>            fpk 产物目录（默认 deploy/fnos/dist）",
      "  --notes <file>          更新说明 markdown（默认 docs/release-notes/<ver>.md）",
      "  --published-at <iso>    测试用：覆盖发布时间",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = { prerelease: false, draft: false, dist: null, notes: null, minVersion: null, tag: null, publishedAt: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tag") out.tag = argv[++i];
    else if (a === "--prerelease") out.prerelease = true;
    else if (a === "--draft") out.draft = true;
    else if (a === "--dist") out.dist = argv[++i];
    else if (a === "--notes") out.notes = argv[++i];
    else if (a === "--min-version") out.minVersion = argv[++i];
    else if (a === "--published-at") out.publishedAt = argv[++i];
    else if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      usage();
      process.exit(64);
    }
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`[publish] ${msg}`);
  process.exit(code);
}

/** 幂等重跑：本 tag 已带 manifest 则取回（固定路径自拼，不用 API 的内网 URL 字段）。 */
async function fetchPreviousManifest(client, tag, token) {
  const release = await client.getReleaseByTag(tag);
  if (!release) return null;
  const asset = (release.assets || []).find((a) => a.name === MANIFEST_ASSET);
  if (!asset) return null;
  const url = client.assetDownloadUrl(tag, MANIFEST_ASSET);
  const res = await fetch(url, { headers: { Authorization: `token ${token}` } });
  if (!res.ok) return null;
  return JSON.parse(await res.text());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tag) fail("缺少 --tag", 64);
  const tagMatch = /^v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(args.tag);
  if (!tagMatch) fail("--tag 必须形如 v0.2.3", 64);
  const version = tagMatch[1];

  const token = process.env.GX_GITEA_TOKEN;
  if (!token || !token.trim()) fail("缺少 GX_GITEA_TOKEN（发布人写令牌，仅从 env 读取）", 64);

  // 1) 版本单源断言：根 package.json.version === tag 去 v。
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (pkg.version !== version) {
    fail(`根 package.json version=${pkg.version} 与 tag 版本 ${version} 不一致（杜绝双版本事故）`, 65);
  }

  // 2) 收集实际存在的 fpk（只按实包生成 artifact，不补占位）。
  const distDir = resolve(REPO_ROOT, args.dist ?? "deploy/fnos/dist");
  if (!existsSync(distDir)) fail(`fpk 产物目录不存在：${distDir}`, 66);
  const fpkFiles = readdirSync(distDir)
    .filter((n) => parseFpkFilename(n) && parseFpkFilename(n).version === version)
    .map((n) => join(distDir, n));
  if (fpkFiles.length === 0) fail(`目录中没有版本 ${version} 的 fpk：${distDir}`, 66);
  const artifacts = artifactsFromFiles(fpkFiles, version);

  const notesFile = args.notes ? resolve(args.notes) : null;
  const notesZh = notesFile ? readFileSync(notesFile, "utf8") : readNotes(REPO_ROOT, version);
  const publishedAt = args.publishedAt ?? new Date().toISOString();

  const client = createGiteaClient({
    baseUrl: DEFAULT_BASE_URL,
    token,
    owner: OWNER,
    repo: REPO,
  });

  // 3) 取旧清单：幂等重跑优先取本 tag 自带；全新发布取 latest release 的清单。
  let previous = await fetchPreviousManifest(client, args.tag, token);
  if (!previous) {
    const latest = await client.getLatestStableRelease();
    if (latest) {
      const url = client.assetDownloadUrl(latest.tag_name, MANIFEST_ASSET);
      const res = await fetch(url, { headers: { Authorization: `token ${token}` } });
      if (res.ok) {
        try {
          previous = JSON.parse(await res.text());
        } catch {
          previous = null;
        }
      }
    }
  }

  // minVersion：显式参数优先；否则继承旧清单最新 release 的 minVersion；再否则 null。
  let minVersion = args.minVersion;
  if (minVersion === null && previous?.channels?.["fnos-fpk"]?.releases?.length) {
    minVersion = previous.channels["fnos-fpk"].releases[0].minVersion ?? null;
  }

  // 4) 合并清单。
  const manifest = buildManifest({
    version,
    artifacts,
    notesZh,
    publishedAt,
    prerelease: args.prerelease,
    minVersion: minVersion ?? null,
    previous,
  });
  const manifestJson = JSON.stringify(manifest, null, 2);

  // 5) 幂等建 release（已存在则复用）。
  let release = await client.getReleaseByTag(args.tag);
  if (!release) {
    release = await client.createRelease({
      tag_name: args.tag,
      name: `构想工作台 ${version}`,
      body: notesZh.trim(),
      prerelease: args.prerelease === true,
      draft: args.draft === true,
    });
    console.log(`[publish] 已创建 release ${args.tag}（id=${release.id}）`);
  } else {
    console.log(`[publish] release ${args.tag} 已存在（id=${release.id}），幂等复用`);
  }

  // 6) 同名资产先删后传（fpk + manifest）。
  const uploads = [
    ...fpkFiles.map((f) => ({ kind: "fpk", path: f, name: f.split("/").pop() })),
    { kind: "manifest", path: null, name: MANIFEST_ASSET, content: Buffer.from(manifestJson, "utf8") },
  ];
  for (const up of uploads) {
    const existing = (release.assets || []).find((a) => a.name === up.name);
    if (existing) {
      await client.deleteAsset(release.id, existing.id);
      console.log(`[publish] 已删除旧资产 ${up.name}`);
    }
    const content = up.content ?? readFileSync(up.path);
    await client.uploadAsset(release.id, up.name, content);
    console.log(`[publish] 已上传 ${up.name}（${content.length} 字节）`);
  }

  // 7) 回读校验：重新取 release，资产齐全且 size 一致；资产头 200。
  const reread = await client.getReleaseByTag(args.tag);
  const byName = new Map((reread.assets || []).map((a) => [a.name, a]));
  for (const up of uploads) {
    const asset = byName.get(up.name);
    if (!asset) fail(`回读校验失败：release 上找不到资产 ${up.name}`, 70);
    const want = up.content ? up.content.length : artifacts.find((a) => a.filename === up.name)?.sizeBytes;
    if (asset.size !== want) fail(`回读校验失败：${up.name} 大小 ${asset.size} != ${want}`, 70);
    const head = await client.headReleaseAsset(args.tag, up.name);
    if (head.size !== want) fail(`回读校验失败：${up.name} HEAD 大小 ${head.size} != ${want}`, 70);
  }

  // 8) 脱敏摘要（只打我们自拼的固定文件名/大小，绝不打 API URL 字段）。
  console.log("[publish] 发布完成");
  console.log(`  tag=${args.tag} prerelease=${args.prerelease} draft=${args.draft}`);
  console.log(`  artifacts: ${artifacts.map((a) => `${a.filename}(${a.sizeBytes}B,sha256=${a.sha256.slice(0, 12)}…)`).join(", ")}`);
  console.log(`  manifest releases(fnOS 段)=${manifest.channels["fnos-fpk"].releases.length}`);
}

main().catch((e) => {
  // GiteaApiError 消息本身已净化；其它错误只打 message，避免堆栈里出现完整带参 URL。
  fail(e?.message ? e.message : String(e), 1);
});

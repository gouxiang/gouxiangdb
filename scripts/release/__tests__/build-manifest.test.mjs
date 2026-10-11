// scripts/release/__tests__/build-manifest.test.mjs
// build-manifest 纯函数表驱动测试（node:test，零第三方依赖）：
//   文件名解析、artifact 与实际 fpk 一一对应（无占位）、sha256/size 实算、
//   prepend 合并 + 只保留最近 10 条、同版本去重、minVersion 透传、非法字段拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  artifactsFromFiles,
  buildManifest,
  parseFpkFilename,
  KEEP_RELEASES,
} from "../build-manifest.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "gx-release-"));
}

function writeFpk(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("parseFpkFilename：x86->x64、arm->arm64、platform 恒 linux", () => {
  assert.deepEqual(parseFpkFilename("gouxiangdb-0.2.3-x86.fpk"), {
    filename: "gouxiangdb-0.2.3-x86.fpk",
    version: "0.2.3",
    arch: "x64",
    platform: "linux",
  });
  assert.equal(parseFpkFilename("gouxiangdb-0.2.3-arm.fpk").arch, "arm64");
  // rc 版 fpk 命名：gouxiangdb-0.2.3-rc1-x86.fpk -> version 0.2.3-rc1
  assert.equal(parseFpkFilename("gouxiangdb-0.2.3-rc1-x86.fpk").version, "0.2.3-rc1");
  assert.equal(parseFpkFilename("evil-0.2.3-x86.fpk"), null);
  assert.equal(parseFpkFilename("gouxiangdb-0.2.3-x64.fpk"), null); // 只认 -x86/-arm
});

test("artifactsFromFiles：与磁盘 fpk 一一对应，size/sha 实算，无占位", () => {
  const dir = tempDir();
  const body = Buffer.from("fake-fpk-bytes-0123456789");
  const p = writeFpk(dir, "gouxiangdb-0.2.3-x86.fpk", body);
  const arts = artifactsFromFiles([p], "0.2.3");
  assert.equal(arts.length, 1);
  assert.deepEqual(arts[0], {
    arch: "x64",
    platform: "linux",
    filename: "gouxiangdb-0.2.3-x86.fpk",
    sizeBytes: body.length,
    sha256: sha(body),
    download: { kind: "release-asset", asset: "gouxiangdb-0.2.3-x86.fpk" },
    signature: null,
  });
});

test("artifactsFromFiles：缺 arm 时绝不补占位（只有实际传入的 x86）", () => {
  const dir = tempDir();
  const p = writeFpk(dir, "gouxiangdb-0.2.3-x86.fpk", "a");
  const arts = artifactsFromFiles([p], "0.2.3");
  assert.deepEqual(arts.map((a) => a.arch), ["x64"]);
});

test("artifactsFromFiles：x86+arm 同时存在则两条，x64 排序在前", () => {
  const dir = tempDir();
  const x86 = writeFpk(dir, "gouxiangdb-0.2.3-x86.fpk", "a");
  const arm = writeFpk(dir, "gouxiangdb-0.2.3-arm.fpk", "bb");
  const arts = artifactsFromFiles([arm, x86], "0.2.3");
  assert.deepEqual(arts.map((a) => a.arch), ["x64", "arm64"]);
});

test("artifactsFromFiles：fpk 版本与发布版本不一致即拒绝", () => {
  const dir = tempDir();
  const p = writeFpk(dir, "gouxiangdb-0.2.2-x86.fpk", "a");
  assert.throws(() => artifactsFromFiles([p], "0.2.3"), /不一致/);
});

test("artifactsFromFiles：同架构重复包拒绝", () => {
  const dir = tempDir();
  const p1 = writeFpk(dir, "gouxiangdb-0.2.3-x86.fpk", "a");
  const p2 = writeFpk(dir, "gouxiangdb-0.2.3-x86.fpk", "b");
  // 同目录同名无法并存；构造两个不同目录同名文件
  const dir2 = tempDir();
  writeFileSync(join(dir2, "gouxiangdb-0.2.3-x86.fpk"), "b");
  assert.throws(() => artifactsFromFiles([p1, join(dir2, "gouxiangdb-0.2.3-x86.fpk")], "0.2.3"), /同一架构/);
  void p2;
});

function makeRelease(version, extra = {}) {
  return {
    version,
    publishedAt: `2026-01-01T00:00:00Z`,
    prerelease: false,
    minVersion: "0.1.0",
    releaseNotes: { format: "markdown", zh: `notes ${version}`, en: null },
    artifacts: [
      {
        arch: "x64",
        platform: "linux",
        filename: `gouxiangdb-${version}-x86.fpk`,
        sizeBytes: 10,
        sha256: "a".repeat(64),
        download: { kind: "release-asset", asset: `gouxiangdb-${version}-x86.fpk` },
        signature: null,
      },
    ],
    ...extra,
  };
}

const baseArgs = (over = {}) => ({
  version: "0.2.3",
  artifacts: [makeRelease("0.2.3").artifacts[0]],
  notesZh: "## 0.2.3\n\n- 新增系统更新。",
  publishedAt: "2026-10-12T08:00:00Z",
  prerelease: false,
  minVersion: "0.1.0",
  previous: null,
  ...over,
});

test("buildManifest：无旧清单时从零起，结构字段齐全", () => {
  const m = buildManifest(baseArgs());
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.product, "gouxiangdb");
  assert.equal(m.generatedAt, "2026-10-12T08:00:00Z");
  const rel = m.channels["fnos-fpk"].releases;
  assert.equal(rel.length, 1);
  assert.equal(rel[0].version, "0.2.3");
  assert.equal(rel[0].artifacts.length, 1);
});

test("buildManifest：新 release prepend 到段首", () => {
  const previous = {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "2026-10-01T00:00:00Z",
    channels: { "fnos-fpk": { releases: [makeRelease("0.2.2"), makeRelease("0.2.1")] } },
  };
  const m = buildManifest(baseArgs({ previous }));
  const versions = m.channels["fnos-fpk"].releases.map((r) => r.version);
  assert.deepEqual(versions, ["0.2.3", "0.2.2", "0.2.1"]);
});

test("buildManifest：同版本旧条目被替换（幂等重跑不重复）", () => {
  const stale = makeRelease("0.2.3", { publishedAt: "2026-09-01T00:00:00Z" });
  const previous = {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "x",
    channels: { "fnos-fpk": { releases: [stale, makeRelease("0.2.2")] } },
  };
  const m = buildManifest(baseArgs({ previous }));
  const rel = m.channels["fnos-fpk"].releases;
  assert.deepEqual(rel.map((r) => r.version), ["0.2.3", "0.2.2"]);
  assert.equal(rel[0].publishedAt, "2026-10-12T08:00:00Z");
});

test(`buildManifest：只保留最近 ${KEEP_RELEASES} 条`, () => {
  const old = Array.from({ length: 12 }, (_, i) => makeRelease(`0.1.${i}`));
  const previous = {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "x",
    channels: { "fnos-fpk": { releases: old } },
  };
  const m = buildManifest(baseArgs({ previous }));
  const rel = m.channels["fnos-fpk"].releases;
  assert.equal(rel.length, KEEP_RELEASES);
  assert.equal(rel[0].version, "0.2.3"); // 新的在首
  // 旧段顺序 0.1.0..0.1.11；新条在首后整体裁到 10 条，末位为 0.1.8（0.1.9..0.1.11 被裁）
  assert.equal(rel[rel.length - 1].version, "0.1.8");
});

test("buildManifest：其它通道段原样保留", () => {
  const other = { releases: [makeRelease("0.2.0")] };
  const previous = {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "x",
    channels: { "source-bare": other, "fnos-fpk": { releases: [makeRelease("0.2.2")] } },
  };
  const m = buildManifest(baseArgs({ previous }));
  assert.equal(m.channels["source-bare"], other);
});

test("buildManifest：minVersion 透传；prerelease 标记透传", () => {
  const m = buildManifest(baseArgs({ minVersion: "0.2.0", prerelease: true }));
  const r = m.channels["fnos-fpk"].releases[0];
  assert.equal(r.minVersion, "0.2.0");
  assert.equal(r.prerelease, true);
});

test("buildManifest：非法输入 fail-closed", () => {
  assert.throws(() => buildManifest(baseArgs({ version: "v0.2.3" })), /非法发布版本/);
  assert.throws(() => buildManifest(baseArgs({ artifacts: [] })), /至少需要 1 个/);
  assert.throws(() => buildManifest(baseArgs({ notesZh: "  " })), /releaseNotes/);
  assert.throws(() => buildManifest(baseArgs({ publishedAt: "nope" })), /非法 publishedAt/);
  assert.throws(() => buildManifest(baseArgs({ minVersion: "abc" })), /非法 minVersion/);
  assert.throws(
    () => buildManifest(baseArgs({ previous: { schemaVersion: 2, product: "gouxiangdb", channels: {} } })),
    /schemaVersion/,
  );
  assert.throws(
    () => buildManifest(baseArgs({ previous: { schemaVersion: 1, product: "other", channels: {} } })),
    /product/,
  );
});

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
  parseDesktopFilename,
  desktopArtifactsFromFiles,
  CHANNEL_FNOS_FPK,
  CHANNEL_DESKTOP_CLIENT,
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

// ---------------------------------------------------------------------------
// desktop-client 通道（v0.3.1 additive）
// ---------------------------------------------------------------------------

test("parseDesktopFilename：扩展名定平台 + 架构 token 归一 + semver 提取（表驱动）", () => {
  const cases = [
    ["GouXiang-0.3.1-arm64.dmg", { version: "0.3.1", arch: "arm64", platform: "darwin" }],
    ["GouXiang-0.3.1-x64.dmg", { version: "0.3.1", arch: "x64", platform: "darwin" }],
    ["GouXiang-0.3.1-x64.msi", { version: "0.3.1", arch: "x64", platform: "win32" }],
    ["GouXiang-0.3.1-x86_64.AppImage", { version: "0.3.1", arch: "x64", platform: "linux" }],
    ["gouxiangdb-0.3.1-aarch64.AppImage", { version: "0.3.1", arch: "arm64", platform: "linux" }],
    // amd64 同义 token -> x64。
    ["GouXiang-0.3.1-amd64.msi", { version: "0.3.1", arch: "x64", platform: "win32" }],
    // rc 版本 token。
    ["GouXiang-0.3.2-rc1-arm64.dmg", { version: "0.3.2-rc1", arch: "arm64", platform: "darwin" }],
    // 大小写不敏感的扩展名/架构。
    ["GouXiang-0.3.1-ARM64.DMG", { version: "0.3.1", arch: "arm64", platform: "darwin" }],
  ];
  for (const [name, want] of cases) {
    const got = parseDesktopFilename(name);
    assert.ok(got, `应能解析：${name}`);
    assert.equal(got.filename, name);
    assert.equal(got.version, want.version, `${name} version`);
    assert.equal(got.arch, want.arch, `${name} arch`);
    assert.equal(got.platform, want.platform, `${name} platform`);
  }
});

test("parseDesktopFilename：要素缺失/非安装包 -> null（fail-closed 不猜）", () => {
  const bad = [
    "GouXiang-0.3.1-arm64.fpk", // 非桌面扩展名
    "GouXiang-0.3.1.dmg", // 缺架构 token
    "GouXiang-arm64.msi", // 缺版本
    "GouXiang-0.3.1-mips64.dmg", // 未知架构
    "notes.txt",
    "",
  ];
  for (const name of bad) assert.equal(parseDesktopFilename(name), null, name);
});

test("desktopArtifactsFromFiles：sha/size 实算、release-asset、signature=null、双键排序", () => {
  const dir = tempDir();
  const dmg = writeFpk(dir, "GouXiang-0.3.1-arm64.dmg", Buffer.from("dmg-bytes"));
  const msi = writeFpk(dir, "GouXiang-0.3.1-x64.msi", Buffer.from("msi-bytes-longer"));
  const app = writeFpk(dir, "GouXiang-0.3.1-x86_64.AppImage", Buffer.from("app"));
  const arts = desktopArtifactsFromFiles([msi, dmg, app], "0.3.1");
  // 排序：darwin -> linux -> win32。
  assert.deepEqual(arts.map((a) => `${a.platform}/${a.arch}`), [
    "darwin/arm64",
    "linux/x64",
    "win32/x64",
  ]);
  const dmgArt = arts[0];
  assert.equal(dmgArt.filename, "GouXiang-0.3.1-arm64.dmg");
  assert.equal(dmgArt.sizeBytes, Buffer.from("dmg-bytes").length);
  assert.equal(dmgArt.sha256, sha(Buffer.from("dmg-bytes")));
  assert.deepEqual(dmgArt.download, {
    kind: "release-asset",
    asset: "GouXiang-0.3.1-arm64.dmg",
  });
  assert.equal(dmgArt.signature, null);
});

test("desktopArtifactsFromFiles：版本不一致 / 同平台架构重复 -> 抛错", () => {
  const dir = tempDir();
  const wrong = writeFpk(dir, "GouXiang-0.3.0-arm64.dmg", "a");
  assert.throws(() => desktopArtifactsFromFiles([wrong], "0.3.1"), /不一致/);
  const d1 = writeFpk(dir, "GouXiang-0.3.1-arm64.dmg", "a");
  const dir2 = tempDir();
  writeFileSync(join(dir2, "GouXiang-0.3.1-arm64.dmg"), "b");
  assert.throws(
    () => desktopArtifactsFromFiles([d1, join(dir2, "GouXiang-0.3.1-arm64.dmg")], "0.3.1"),
    /同一平台\/架构/,
  );
});

function desktopArtifact(over = {}) {
  return {
    arch: "arm64",
    platform: "darwin",
    filename: "GouXiang-0.3.1-arm64.dmg",
    sizeBytes: 9,
    sha256: "d".repeat(64),
    download: { kind: "release-asset", asset: "GouXiang-0.3.1-arm64.dmg" },
    signature: null,
    ...over,
  };
}

test("buildManifest：传入 desktopArtifacts 时写 desktop-client 段且 fnos 段不受影响", () => {
  const m = buildManifest({
    ...baseArgs(),
    desktopArtifacts: [desktopArtifact()],
  });
  // fnos-fpk 仍只有 fpk 一个 release（逻辑原样）。
  assert.equal(m.channels[CHANNEL_FNOS_FPK].releases.length, 1);
  const desk = m.channels[CHANNEL_DESKTOP_CLIENT];
  assert.ok(desk, "必须出现 desktop-client 通道段");
  const rel = desk.releases[0];
  assert.equal(rel.version, "0.2.3"); // 与本次发布版本一致（baseArgs.version）
  assert.equal(rel.artifacts[0].platform, "darwin");
  assert.equal(rel.artifacts[0].arch, "arm64");
  // 桌面段与 fnos 段共享版本元数据，仅 artifacts 不同。
  assert.equal(rel.publishedAt, m.channels[CHANNEL_FNOS_FPK].releases[0].publishedAt);
});

test("buildManifest：桌面段同版本去重 + prepend + 裁 KEEP_RELEASES", () => {
  const prevDesktop = {
    releases: Array.from({ length: 12 }, (_, i) => ({
      version: `0.1.${i}`,
      publishedAt: "2026-01-01T00:00:00Z",
      prerelease: false,
      minVersion: null,
      releaseNotes: { format: "markdown", zh: `n ${i}`, en: null },
      artifacts: [desktopArtifact({ filename: `old-${i}.dmg`, sha256: "e".repeat(64) })],
    })),
  };
  const previous = {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "x",
    channels: { [CHANNEL_DESKTOP_CLIENT]: prevDesktop },
  };
  const m = buildManifest({ ...baseArgs({ previous }), desktopArtifacts: [desktopArtifact()] });
  const rel = m.channels[CHANNEL_DESKTOP_CLIENT].releases;
  assert.equal(rel.length, KEEP_RELEASES);
  assert.equal(rel[0].version, "0.2.3"); // 新条在首
});

test("buildManifest：不传 desktopArtifacts 时输出与旧版逐字节一致（无 desktop 键、旧桌面段原样保留）", () => {
  // 1) 从零起：不含 desktop-client 键，结构为固定字面量。
  const fresh = buildManifest(baseArgs());
  assert.equal(CHANNEL_DESKTOP_CLIENT in fresh.channels, false);
  assert.deepEqual(Object.keys(fresh.channels), [CHANNEL_FNOS_FPK]);
  assert.equal(
    JSON.stringify(fresh),
    JSON.stringify({
      schemaVersion: 1,
      product: "gouxiangdb",
      generatedAt: "2026-10-12T08:00:00Z",
      channels: {
        "fnos-fpk": {
          releases: [
            {
              version: "0.2.3",
              publishedAt: "2026-10-12T08:00:00Z",
              prerelease: false,
              minVersion: "0.1.0",
              releaseNotes: { format: "markdown", zh: "## 0.2.3\n\n- 新增系统更新。", en: null },
              artifacts: [makeRelease("0.2.3").artifacts[0]],
            },
          ],
        },
      },
    }),
  );

  // 2) 旧清单里已存在 desktop-client 段：未传参时按「其它通道」原样保留（不被剔除/重建）。
  const legacyDesktop = { releases: [{ version: "0.9.9", keep: true }] };
  const previous = {
    schemaVersion: 1,
    product: "gouxiangdb",
    generatedAt: "x",
    channels: { [CHANNEL_DESKTOP_CLIENT]: legacyDesktop, "fnos-fpk": { releases: [makeRelease("0.2.2")] } },
  };
  const kept = buildManifest(baseArgs({ previous }));
  assert.equal(kept.channels[CHANNEL_DESKTOP_CLIENT], legacyDesktop);
});

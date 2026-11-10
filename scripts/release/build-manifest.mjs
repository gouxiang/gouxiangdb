// scripts/release/build-manifest.mjs
// 生成/演进 update-manifest.json（DESIGN §5.1/§8.2/§8.3）。
//
// 铁律：
//   - artifact 条目只按磁盘上【实际存在】的 fpk 生成，绝不为缺失的 arch 补占位条目（本期只有 x86）；
//   - 每次发布的 manifest 自带完整最近 10 个 release（拉上一版清单，新 release prepend 到段首）；
//   - artifact sha256 由文件实算（crypto，hex 小写 64 位），sizeBytes 用 fs.statSync；
//   - schemaVersion 固定 1；additive 演进不升版本（§8.3）；
//   - 纯函数 buildManifest 可被 node:test 表驱动测试，不碰网络。
import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1;
export const PRODUCT = "gouxiangdb";
export const CHANNEL_FNOS_FPK = "fnos-fpk";
export const CHANNEL_DESKTOP_CLIENT = "desktop-client";
export const KEEP_RELEASES = 10;

// gouxiangdb-0.2.3-x86.fpk -> x64；-arm.fpk -> arm64。platform 恒 linux（飞牛 fpk）。
const FPK_NAME_RE = /^gouxiangdb-([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)-(x86|arm)\.fpk$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// 桌面安装包：扩展名定平台（大小写不敏感）。
const DESKTOP_EXT_PLATFORM = [
  [/\.dmg$/i, "darwin"],
  [/\.msi$/i, "win32"],
  [/\.AppImage$/i, "linux"],
];
// 桌面架构 token（大小写不敏感，长名优先；输出归一到 x64/arm64）。
const DESKTOP_ARCH_RE = /(^|[-_.])(arm64|aarch64|x86_64|amd64|x64)(?=[-_.]|$)/i;
// 摘除扩展名/架构后从剩余文件名提 semver（含可选预发布段）。
const DESKTOP_VERSION_RE = /([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/;

export function parseFpkFilename(name) {
  const m = FPK_NAME_RE.exec(name);
  if (!m) return null;
  return {
    filename: name,
    version: m[1],
    arch: m[2] === "x86" ? "x64" : "arm64",
    platform: "linux",
  };
}

export function sha256File(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * 从磁盘 fpk 构造 artifact 清单（一一对应，无占位）。
 * @param {{file:string}[]} files 已确认存在的 fpk 文件（绝对/相对路径）
 * @param {string} expectVersion 必须与文件名解析出版本一致，否则抛错（防拿错包发布）
 */
export function artifactsFromFiles(files, expectVersion) {
  const artifacts = [];
  const seen = new Set();
  for (const file of files) {
    const abs = resolve(file);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`不是文件：${file}`);
    const parsed = parseFpkFilename(file.split("/").pop().split("\\").pop());
    if (!parsed) throw new Error(`无法解析 fpk 文件名（应为 gouxiangdb-<ver>-<x86|arm>.fpk）：${file}`);
    if (parsed.version !== expectVersion) {
      throw new Error(`fpk 版本 ${parsed.version} 与发布版本 ${expectVersion} 不一致：${file}`);
    }
    const key = `${parsed.platform}/${parsed.arch}`;
    if (seen.has(key)) throw new Error(`同一架构存在多个 fpk：${key}`);
    seen.add(key);
    artifacts.push({
      arch: parsed.arch,
      platform: parsed.platform,
      filename: parsed.filename,
      sizeBytes: st.size,
      sha256: sha256File(abs),
      download: { kind: "release-asset", asset: parsed.filename },
      signature: null,
    });
  }
  // 稳定排序：x64 在前（字典序会让 arm64 在前，显式给权重）。
  const archWeight = { x64: 0, arm64: 1 };
  artifacts.sort((a, b) => (archWeight[a.arch] ?? 9) - (archWeight[b.arch] ?? 9));
  return artifacts;
}

/**
 * 解析桌面安装包文件名 -> { filename, version, arch, platform }；无法识别返回 null。
 * 扩展名定平台（.dmg→darwin / .msi→win32 / .AppImage→linux），架构 token 定 arch
 *（arm64/aarch64→arm64，x64/x86_64/amd64→x64），版本取摘除架构后的 semver token。
 * 任一要素缺失即判无法解析（fail-closed，不猜平台/架构）。
 */
export function parseDesktopFilename(name) {
  if (typeof name !== "string" || name.trim() === "") return null;
  const base = name.split("/").pop().split("\\").pop();

  const extEntry = DESKTOP_EXT_PLATFORM.find(([re]) => re.test(base));
  if (!extEntry) return null;
  const platform = extEntry[1];

  // 去扩展名，再摘掉架构 token（避免架构段被版本正则的预发布部分吞进去）。
  const stem = base.replace(/\.(dmg|msi|AppImage)$/i, "");
  const archMatch = DESKTOP_ARCH_RE.exec(stem);
  if (!archMatch) return null;
  const archToken = archMatch[2].toLowerCase();
  const arch = archToken === "arm64" || archToken === "aarch64" ? "arm64" : "x64";
  // 整体摘除「分隔符+架构 token」，避免残留分隔符被版本正则的预发布段吞进去。
  const stemNoArch = stem.replace(DESKTOP_ARCH_RE, "");

  const versionMatch = DESKTOP_VERSION_RE.exec(stemNoArch);
  if (!versionMatch) return null;

  return { filename: base, version: versionMatch[1], arch, platform };
}

/**
 * 从磁盘桌面安装包构造 desktop-client artifact 清单（实算 sha256/size，无占位）。
 * @param {{file:string}[]} files 已确认存在的安装包（.dmg/.msi/.AppImage，绝对/相对路径）
 * @param {string} expectVersion 必须与文件名解析出版本一致，否则抛错（防拿错包发布）
 * 同一 platform/arch 双键去重（重复即抛错）；release-asset 下载、signature 恒 null。
 */
export function desktopArtifactsFromFiles(files, expectVersion) {
  const artifacts = [];
  const seen = new Set();
  for (const file of files) {
    const abs = resolve(file);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`不是文件：${file}`);
    const name = file.split("/").pop().split("\\").pop();
    const parsed = parseDesktopFilename(name);
    if (!parsed) {
      throw new Error(
        `无法解析桌面安装包文件名（应为含 semver 与架构 token 的 .dmg/.msi/.AppImage）：${file}`,
      );
    }
    if (parsed.version !== expectVersion) {
      throw new Error(
        `桌面包版本 ${parsed.version} 与发布版本 ${expectVersion} 不一致：${file}`,
      );
    }
    const key = `${parsed.platform}/${parsed.arch}`;
    if (seen.has(key)) throw new Error(`同一平台/架构存在多个桌面包：${key}`);
    seen.add(key);
    artifacts.push({
      arch: parsed.arch,
      platform: parsed.platform,
      filename: parsed.filename,
      sizeBytes: st.size,
      sha256: sha256File(abs),
      download: { kind: "release-asset", asset: parsed.filename },
      signature: null,
    });
  }
  // 稳定排序：先平台（darwin→linux→win32）再架构（x64→arm64），保证产物顺序确定。
  const platformWeight = { darwin: 0, linux: 1, win32: 2 };
  const archWeight = { x64: 0, arm64: 1 };
  artifacts.sort(
    (a, b) =>
      (platformWeight[a.platform] ?? 9) - (platformWeight[b.platform] ?? 9)
      || (archWeight[a.arch] ?? 9) - (archWeight[b.arch] ?? 9),
  );
  return artifacts;
}

function assertPreviousShape(prev) {
  if (prev === null || prev === undefined) return;
  if (typeof prev !== "object") throw new Error("旧 manifest 不是对象");
  if (prev.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`旧 manifest schemaVersion=${String(prev.schemaVersion)}，本脚本只产 ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (prev.product !== PRODUCT) throw new Error("旧 manifest product 不匹配");
  if (typeof prev.channels !== "object" || prev.channels === null) throw new Error("旧 manifest channels 缺失");
}

/**
 * 纯函数：组装新 manifest。
 * @param {object} p
 * @param {string} p.version 发布版本
 * @param {object[]} p.artifacts artifactsFromFiles 的产物（至少 1 个）
 * @param {string} p.notesZh 中文更新说明（markdown 正文）
 * @param {string} p.publishedAt ISO 时间
 * @param {boolean} p.prerelease
 * @param {string|null} p.minVersion
 * @param {object|null} p.previous 上一版 manifest 对象（无则从零起）
 * @param {object[]} [p.desktopArtifacts] 可选：desktopArtifactsFromFiles 的桌面安装包产物。
 *   不传（undefined）时本函数输出与旧版【逐字节一致】；传入非空数组时额外维护 desktop-client
 *   通道段（同版本剔除后 prepend、裁 KEEP_RELEASES），fnos-fpk 逻辑原样不动。
 */
export function buildManifest({ version, artifacts, notesZh, publishedAt, prerelease, minVersion, previous, desktopArtifacts }) {
  if (!VERSION_RE.test(version)) throw new Error(`非法发布版本：${version}`);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("至少需要 1 个 artifact（不得补占位）");
  if (typeof notesZh !== "string" || notesZh.trim() === "") throw new Error("releaseNotes.zh 不能为空");
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error(`非法 publishedAt：${publishedAt}`);
  if (minVersion !== null && (typeof minVersion !== "string" || !VERSION_RE.test(minVersion))) {
    throw new Error(`非法 minVersion：${String(minVersion)}`);
  }
  assertPreviousShape(previous);

  // 仅当显式传入非空桌面包时才维护 desktop-client 段；否则完全走旧路径（逐字节不变）。
  const withDesktop = Array.isArray(desktopArtifacts) && desktopArtifacts.length > 0;

  const newRelease = {
    version,
    publishedAt,
    prerelease: prerelease === true,
    minVersion: minVersion ?? null,
    releaseNotes: { format: "markdown", zh: notesZh.trim(), en: null },
    artifacts,
  };

  // 其它通道原样保留；fnos-fpk 段（以及启用桌面段时的 desktop-client 段）另行重建。
  const channels = {};
  if (previous) {
    for (const [cid, seg] of Object.entries(previous.channels)) {
      if (cid === CHANNEL_FNOS_FPK) continue;
      if (withDesktop && cid === CHANNEL_DESKTOP_CLIENT) continue;
      channels[cid] = seg;
    }
  }
  const oldFnos = previous?.channels?.[CHANNEL_FNOS_FPK]?.releases;
  const kept = Array.isArray(oldFnos) ? oldFnos.filter((r) => r.version !== version) : [];
  const fnosReleases = [newRelease, ...kept].slice(0, KEEP_RELEASES);
  channels[CHANNEL_FNOS_FPK] = { releases: fnosReleases };

  if (withDesktop) {
    // 桌面段与 fnos 段同构：复用同一版本元数据/说明，仅 artifacts 换成桌面安装包。
    const newDesktopRelease = {
      version,
      publishedAt,
      prerelease: prerelease === true,
      minVersion: minVersion ?? null,
      releaseNotes: { format: "markdown", zh: notesZh.trim(), en: null },
      artifacts: desktopArtifacts,
    };
    const oldDesktop = previous?.channels?.[CHANNEL_DESKTOP_CLIENT]?.releases;
    const keptDesktop = Array.isArray(oldDesktop)
      ? oldDesktop.filter((r) => r.version !== version)
      : [];
    channels[CHANNEL_DESKTOP_CLIENT] = {
      releases: [newDesktopRelease, ...keptDesktop].slice(0, KEEP_RELEASES),
    };
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: PRODUCT,
    generatedAt: publishedAt,
    channels,
  };
}

/** CLI 帮助在 publish 编排里不直接调用；此处仅导出供测试/编排复用。 */
export function readNotes(repoRoot, version) {
  const p = resolve(repoRoot, "docs/release-notes", `${version}.md`);
  return readFileSync(p, "utf8");
}

// apps/api/src/domain/update/manifest.ts
// parseUpdateManifest：更新清单的结构级门禁 + 前向兼容裁剪（DESIGN §3.2、§4.1 规则 7、§5.1）。
//
// 纯函数、不碰网络/文件：source 层拿到的原始 JSON 文本由这里唯一收口成 UpdateManifest。
// 容错纪律（向前兼容 + fail-closed 并举）：
//   - schemaVersion===1 才认识；>1 报 newerSchema（调用方弱提示、update=null）；其余/错类型=非法清单；
//   - product 必须是 "gouxiangdb"；
//   - 未知通道段、未知字段一律忽略（重新构造对象即天然裁剪，不把多余键透传给 DTO）；
//   - 单条 release 版本不可解析（§4.1 规则 7）或标量字段坏=跳过该条；
//   - 单个 artifact 坏=跳过该 artifact；release 无任何合法 artifact=跳过该 release；
//   - 整份清单结构级坏掉（schema/product/根类型错）= 抛 UPDATE_MANIFEST_INVALID。
// 「该通道跳过所有条目后无合法 release」由 service 层据通道段是否存在/是否空决定，本层只做净化。

import {
  parseVersion,
  type ArtifactManifest,
  type ChannelManifest,
  type ReleaseManifest,
  type UpdateManifest,
} from "@gx/shared-types";
import { UpdateSourceError } from "./types.js";

export interface ParsedManifest {
  manifest: UpdateManifest;
  /** 清单 schemaVersion 高于本端认识值（=1）：不报错，面板弱提示。 */
  newerSchema: boolean;
}

const KNOWN_SCHEMA = 1;
const PRODUCT = "gouxiangdb";
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ARCHES = new Set(["x64", "arm64", "any"]);
const PLATFORMS = new Set(["linux", "darwin", "win32", "any"]);
const SIGNATURE_ALGS = new Set(["minisign", "gpg"]);
const NOTES_FORMATS = new Set(["markdown", "text"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(reason: string): never {
  // 原因仅入服务端日志/测试，不含上游响应体，避免泄漏内网细节。
  throw new UpdateSourceError("UPDATE_MANIFEST_INVALID", `更新清单结构非法：${reason}`);
}

function parseArtifact(raw: unknown): ArtifactManifest | null {
  if (!isObject(raw)) return null;
  const { arch, platform, filename, sizeBytes, sha256, download, signature } = raw;

  if (typeof arch !== "string" || !ARCHES.has(arch)) return null;
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) return null;
  if (typeof filename !== "string" || filename.trim() === "") return null;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) return null;
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return null;

  let dl: ArtifactManifest["download"] | null = null;
  if (isObject(download)) {
    if (download.kind === "release-asset" && typeof download.asset === "string" && download.asset.trim() !== "") {
      dl = { kind: "release-asset", asset: download.asset };
    } else if (download.kind === "url" && typeof download.url === "string" && download.url.trim() !== "") {
      dl = { kind: "url", url: download.url };
    }
  }
  if (!dl) return null;

  let sig: ArtifactManifest["signature"] = null;
  if (signature !== null && signature !== undefined) {
    if (
      isObject(signature)
      && typeof signature.alg === "string"
      && SIGNATURE_ALGS.has(signature.alg)
      && typeof signature.value === "string"
      && signature.value.trim() !== ""
    ) {
      sig = { alg: signature.alg as "minisign" | "gpg", value: signature.value };
    } else {
      // 签名字段存在但形状坏：不静默丢弃安全语义，判该 artifact 非法。
      return null;
    }
  }

  return {
    arch: arch as ArtifactManifest["arch"],
    platform: platform as ArtifactManifest["platform"],
    filename,
    sizeBytes,
    sha256: sha256.toLowerCase(),
    download: dl,
    signature: sig,
  };
}

function parseRelease(raw: unknown): ReleaseManifest | null {
  if (!isObject(raw)) return null;
  const { version, publishedAt, prerelease, minVersion, releaseNotes, artifacts } = raw;

  // 版本不可解析（含 0.0.0-dev 哨兵）：规则 7，跳过整条。
  if (typeof version !== "string" || !parseVersion(version).valid) return null;
  if (typeof publishedAt !== "string" || publishedAt.trim() === "") return null;
  if (typeof prerelease !== "boolean") return null;
  if (minVersion !== null && typeof minVersion !== "string") return null;
  if (typeof minVersion === "string" && minVersion.trim() !== "" && !parseVersion(minVersion).valid) {
    return null;
  }

  if (!isObject(releaseNotes)) return null;
  if (typeof releaseNotes.format !== "string" || !NOTES_FORMATS.has(releaseNotes.format)) return null;
  if (typeof releaseNotes.zh !== "string" || releaseNotes.zh.trim() === "") return null;
  if (releaseNotes.en !== null && typeof releaseNotes.en !== "string") return null;

  if (!Array.isArray(artifacts)) return null;
  const parsedArtifacts = artifacts
    .map(parseArtifact)
    .filter((a): a is ArtifactManifest => a !== null);
  if (parsedArtifacts.length === 0) return null;

  return {
    version,
    publishedAt,
    prerelease,
    minVersion: typeof minVersion === "string" && minVersion.trim() !== "" ? minVersion : null,
    releaseNotes: {
      format: releaseNotes.format as "markdown" | "text",
      zh: releaseNotes.zh,
      en: releaseNotes.en,
    },
    artifacts: parsedArtifacts,
  };
}

/**
 * 解析更新清单。成功返回净化后的 manifest（只含认识的字段/通道）与 newerSchema 标记；
 * 结构级非法抛 UpdateSourceError(UPDATE_MANIFEST_INVALID)。
 */
export function parseUpdateManifest(raw: unknown): ParsedManifest {
  if (!isObject(raw)) invalid("根不是对象");

  if (typeof raw.schemaVersion !== "number" || !Number.isInteger(raw.schemaVersion)) {
    invalid("schemaVersion 缺失或非整数");
  }
  if (raw.schemaVersion > KNOWN_SCHEMA) {
    // 前向兼容：高版本清单不按「错误」处理，交给调用方弱提示。
    return {
      manifest: {
        schemaVersion: KNOWN_SCHEMA,
        product: PRODUCT,
        generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
        channels: {},
      },
      newerSchema: true,
    };
  }
  if (raw.schemaVersion < KNOWN_SCHEMA) invalid(`不支持的旧 schemaVersion=${raw.schemaVersion}`);

  if (raw.product !== PRODUCT) invalid(`product 不是 ${PRODUCT}`);
  if (typeof raw.generatedAt !== "string" || raw.generatedAt.trim() === "") {
    invalid("generatedAt 缺失");
  }
  if (!isObject(raw.channels)) invalid("channels 缺失或非对象");

  const channels: UpdateManifest["channels"] = {};
  for (const [channelId, segRaw] of Object.entries(raw.channels)) {
    if (!isObject(segRaw) || !Array.isArray(segRaw.releases)) continue; // 未知/坏通道段忽略
    const releases = segRaw.releases
      .map(parseRelease)
      .filter((r): r is ReleaseManifest => r !== null);
    // 即便 releases 被全部跳过也保留该段（空数组），service 据此区分「通道存在但无合法条目」
    // （→ MANIFEST_INVALID）与「通道缺失」（→ update=null）。
    const segment: ChannelManifest = { releases };
    channels[channelId] = segment;
  }

  return {
    manifest: {
      schemaVersion: KNOWN_SCHEMA,
      product: PRODUCT,
      generatedAt: raw.generatedAt,
      channels,
    },
    newerSchema: false,
  };
}

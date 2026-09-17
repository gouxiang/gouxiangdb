// scripts/acceptance/seed/uploads.mjs
// 五类附件物理文件 + 确定性字节（LCG seed42），直接落 UPLOAD_ROOT/at/。
// 采用 R6 分阶段口径：G2 旧库阶段做到「记录数 + 引用不悬空 + <=2MB 各类样本磁盘 sha256 字节持久」；
// 公开 2MB / 内部 10MB 的边界上传在候选构建 §7.4 冒烟里真打（不在旧库强灌 10MB）。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { randomBytes } from "../lib/lcg.mjs";

// 五类：图片 png / 视频 mp4 / 音频 mp3 / PDF / 普通 bin。每类 2 个。
// 其中 bin 类第二个 = 恰 2MiB 边界；bin 类第三个（不引用）= 2MiB+1 越界，仅验清单稳定。
export const ATTACHMENT_SPECS = [
  { id: "drill_img_1", ext: "png", mime: "image/png", size: 48 * 1024, referenced: true },
  { id: "drill_img_2", ext: "png", mime: "image/png", size: 96 * 1024, referenced: true },
  { id: "drill_vid_1", ext: "mp4", mime: "video/mp4", size: 256 * 1024, referenced: true },
  { id: "drill_vid_2", ext: "mp4", mime: "video/mp4", size: 320 * 1024, referenced: true },
  { id: "drill_aud_1", ext: "mp3", mime: "audio/mpeg", size: 128 * 1024, referenced: true },
  { id: "drill_aud_2", ext: "mp3", mime: "audio/mpeg", size: 160 * 1024, referenced: true },
  { id: "drill_pdf_1", ext: "pdf", mime: "application/pdf", size: 200 * 1024, referenced: true },
  { id: "drill_pdf_2", ext: "pdf", mime: "application/pdf", size: 240 * 1024, referenced: true },
  { id: "drill_bin_1", ext: "bin", mime: "application/octet-stream", size: 180 * 1024, referenced: true },
  { id: "drill_bin_2", ext: "bin", mime: "application/octet-stream", size: 2 * 1024 * 1024, referenced: true },
  { id: "drill_bin_over", ext: "bin", mime: "application/octet-stream", size: 2 * 1024 * 1024 + 1, referenced: false },
];

/**
 * 生成全部附件到 <uploadRoot>/at/，返回清单数组。
 * @param {() => number} rng
 * @param {string} uploadRoot
 * @returns {Array<{id:string,relPath:string,name:string,size:number,mime:string,sha256:string,referenced:boolean}>}
 */
export function materializeUploads(rng, uploadRoot) {
  const atDir = path.join(uploadRoot, "at");
  fs.mkdirSync(atDir, { recursive: true });
  const manifest = [];
  for (const spec of ATTACHMENT_SPECS) {
    const name = `${spec.id}.${spec.ext}`;
    const relPath = `at/${name}`;
    const abs = path.join(atDir, name);
    const buf = deterministicFileBytes(rng, spec);
    fs.writeFileSync(abs, buf);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    manifest.push({
      id: spec.id,
      relPath,
      name,
      size: spec.size,
      mime: spec.mime,
      sha256,
      referenced: spec.referenced,
    });
  }
  return manifest;
}

/**
 * 确定性字节：固定魔数前缀（便于 file 类型辨认）+ LCG 填充，总长恰为 spec.size。
 */
function deterministicFileBytes(rng, spec) {
  const buf = randomBytes(rng, spec.size);
  const magic = magicFor(spec.ext);
  buf.write(magic, 0, "utf8");
  // 尾部写 id，保证不同文件即便长度相同 sha256 也不同
  buf.write(spec.id, Math.max(0, spec.size - spec.id.length - 1), "utf8");
  return buf;
}

function magicFor(ext) {
  switch (ext) {
    case "png": return "\x89PNG\r\n\x1a\n";
    case "mp4": return "\x00\x00\x00 ftypmp42";
    case "mp3": return "ID3\x03\x00";
    case "pdf": return "%PDF-1.7\n";
    default: return "GXBIN\x00";
  }
}

/**
 * 组装记录里 attachment 字段的 JSON 值（{id,name,size,mime,url} 数组，对齐 v1 AttachmentValue）。
 */
export function attachmentCellValue(entries) {
  return entries.map((m) => ({
    id: m.id,
    name: m.name,
    size: m.size,
    mime: m.mime,
    url: `/uploads/${m.relPath}`,
  }));
}

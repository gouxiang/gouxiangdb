#!/usr/bin/env node
// apps/desktop/poc/make-poc3-manifest.mjs
//
// PoC-3 专用：从 Tauri 产出的 <Name>.app.tar.gz + .sig 生成 updater 的 latest.json。
// 仅自测用，不进生产打包矩阵（正式版的等价物是 D4 的 scripts/make-latest-json.mjs）。
//
// 用法：
//   node make-poc3-manifest.mjs \
//     --tar <.../X.app.tar.gz> --sig <.../X.app.tar.gz.sig> \
//     --version 0.2.0 --base http://127.0.0.1:18080 \
//     --srcdir <静态源目录> [--remote GouXiangDB-0.2.0.app.tar.gz] \
//     [--notes "..."] [--tamper]
//
// 行为：
//   - 把 tar.gz（篡改模式下为翻转 1 字节后的副本）以 ASCII 名放进 --srcdir，规避中文 URL 编码；
//   - signature 字段放 .sig 文件【全文】（minisign 的 base64 串）；
//   - 正常模式：包与签名匹配，updater 应校验通过并安装；
//   - --tamper：包内容被改 1 字节但仍配原 .sig → minisign 校验必失败，updater 必须拒绝、不安装。

import fs from "node:fs";
import path from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function need(name) {
  const v = arg(name);
  if (!v) {
    console.error(`缺少必填参数 --${name}`);
    process.exit(2);
  }
  return v;
}

const tarIn = path.resolve(need("tar"));
const sigIn = path.resolve(need("sig"));
const version = need("version");
const base = arg("base", "http://127.0.0.1:18080").replace(/\/+$/, "");
const srcdir = path.resolve(need("srcdir"));
const remote = arg("remote", `GouXiangDB-${version}.app.tar.gz`);
const notes = arg("notes", `PoC-3 测试版本 ${version}`);
const tamper = process.argv.includes("--tamper");

if (!fs.existsSync(tarIn)) { console.error("tar 不存在", tarIn); process.exit(2); }
if (!fs.existsSync(sigIn)) { console.error("sig 不存在", sigIn); process.exit(2); }
fs.mkdirSync(srcdir, { recursive: true });

const destTar = path.join(srcdir, remote);
if (tamper) {
  const buf = fs.readFileSync(tarIn);
  // 翻转 gzip 中部一字节（避开头尾），保证字节级不同且仍能传输，签名必然对不上。
  const at = Math.min(buf.length - 8, Math.floor(buf.length * 0.37));
  buf[at] = buf[at] ^ 0xff;
  fs.writeFileSync(destTar, buf);
  console.log(`[poc3-manifest] 篡改包已写出：${destTar}（翻转偏移 ${at}，${buf.length} B）`);
} else {
  fs.copyFileSync(tarIn, destTar);
  console.log(`[poc3-manifest] 正常包已写出：${destTar}（${fs.statSync(destTar).size} B）`);
}

const signature = fs.readFileSync(sigIn, "utf8").trim();
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { signature, url: `${base}/${remote}` },
  },
};
const outJson = path.join(srcdir, "latest.json");
fs.writeFileSync(outJson, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[poc3-manifest] ${outJson}`);
console.log(`[poc3-manifest] version=${version} url=${base}/${remote} signature=${signature.length} 字符`);

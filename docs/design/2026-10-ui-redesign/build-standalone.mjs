#!/usr/bin/env node
/* 把 index.html + assets/* 内联成 standalone.html
   用途：预览面板 / Quick Look 等拦截外部本地脚本的环境。
   单一来源仍是 index.html + assets/，本文件是生成物，改了源文件要重跑。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), "utf8");

let html = read("index.html");

const inline = (file) => `<style>\n${read(file)}\n</style>`;
const inlineJs = (file) => `<script>\n${read(file)}\n</script>`;

html = html
  .replace('<link rel="stylesheet" href="./assets/tokens.css" />', inline("assets/tokens.css"))
  .replace('<link rel="stylesheet" href="./assets/proto.css" />', inline("assets/proto.css"))
  .replace('<script src="./assets/pages.js"></script>', inlineJs("assets/pages.js"))
  .replace('<script src="./assets/app.js"></script>', inlineJs("assets/app.js"))
  .replace(
    "<title>构想工作台 · UI v2 全域骨架</title>",
    "<title>构想工作台 · UI v2 全域骨架（单文件版）</title>",
  );

const out = path.join(here, "standalone.html");
fs.writeFileSync(out, html, "utf8");
console.log(`standalone.html 已生成：${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);

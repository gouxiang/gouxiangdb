#!/usr/bin/env node
/* 把 pages/*.html 里引用 ../assets/real-ui.css 的 <link> 内联成 <style>
   原因：WorkBuddy 预览面板按"单文件"托管，跨文件相对引用全部 404，
   只有自包含单文件能在面板里正常显示。浏览器 file:// 下两种都正常。
   幂等：已内联（无 link）的文件跳过。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.join(here, "pages");
const css = fs.readFileSync(path.join(here, "assets", "real-ui.css"), "utf8");
const LINK = '<link rel="stylesheet" href="../assets/real-ui.css" />';

for (const file of fs.readdirSync(pagesDir)) {
  if (!file.endsWith(".html")) continue;
  const p = path.join(pagesDir, file);
  let html = fs.readFileSync(p, "utf8");
  if (!html.includes(LINK)) {
    console.log(`跳过（已内联）: ${file}`);
    continue;
  }
  html = html.replace(LINK, `<style>\n${css}\n</style>`);
  fs.writeFileSync(p, html, "utf8");
  console.log(`已内联: ${file} → ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
}

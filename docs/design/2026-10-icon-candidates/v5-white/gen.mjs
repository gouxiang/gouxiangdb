// V5：参考「白底 squircle + 中央彩色圆头笔画图形」骨架重做
// 图形换成构想工作台自己的意象；每方案仍 ≤3 个形状
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const BASE = `
  <rect x="1.5" y="1.5" width="253" height="253" rx="56" fill="#FFFFFF" stroke="#E7EBF3" stroke-width="3"/>`;

const schemes = [
  {
    key: 'A',
    file: 'A-思维波',
    name: '思维波 M',
    palette: ['#3A6DF0', '#FF7A29'],
    desc: '一笔 M 形圆头波线，蓝渐变到橙——思维的起伏与迸发。骨架和参考图同款（圆头粗笔画 + 渐变），但语义是「构想」。',
    inner: `
      <defs><linearGradient id="gA" x1="70" y1="170" x2="186" y2="94" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3A6DF0"/><stop offset="1" stop-color="#FF7A29"/></linearGradient></defs>
      ${BASE}
      <polyline points="70,170 102,94 128,152 154,94 186,170" fill="none" stroke="url(#gA)"
        stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    key: 'B',
    file: 'B-双笔交错',
    name: '双笔交错',
    palette: ['#3A6DF0', '#FF7A29'],
    desc: '蓝橙两笔交错搭成一个 M，结构上最接近参考图的双字母交叠，但不拼写任何字母，纯粹是「两股想法交汇」。',
    inner: `
      ${BASE}
      <path d="M76 170 L114 88 L146 142" fill="none" stroke="#3A6DF0" stroke-width="22"
        stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M108 144 L142 88 L180 170" fill="none" stroke="#FF7A29" stroke-width="22"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.93"/>`,
  },
  {
    key: 'C',
    file: 'C-上升线',
    name: '上升线',
    palette: ['#3A6DF0', '#FF7A29'],
    desc: '一条从左下攀到右上的圆头折线，末端一颗橙点——想法成形、持续向上。最「工作台」的一个。',
    inner: `
      <defs><linearGradient id="gC" x1="74" y1="178" x2="184" y2="84" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3A6DF0"/><stop offset="1" stop-color="#FF7A29"/></linearGradient></defs>
      ${BASE}
      <polyline points="74,178 120,122 148,146 184,84" fill="none" stroke="url(#gC)"
        stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="184" cy="84" r="15" fill="#FF7A29"/>`,
  },
  {
    key: 'D',
    file: 'D-G笔画',
    name: 'G 笔画',
    palette: ['#3A6DF0', '#FF7A29'],
    desc: '圆头粗笔画写的 G（gouxiangdb），收笔处一点橙。参考图同款笔触，但是个真正的字母标。',
    inner: `
      <defs><linearGradient id="gD" x1="70" y1="80" x2="190" y2="170" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3A6DF0"/><stop offset="1" stop-color="#FF7A29"/></linearGradient></defs>
      ${BASE}
      <path d="M176 94 A60 60 0 1 0 188 130" fill="none" stroke="url(#gD)"
        stroke-width="22" stroke-linecap="round"/>
      <line x1="130" y1="130" x2="188" y2="130" stroke="#FF7A29" stroke-width="22" stroke-linecap="round"/>`,
  },
  {
    key: 'E',
    file: 'E-节点三角',
    name: '节点三角',
    palette: ['#3A6DF0', '#00B894', '#FF7A29'],
    desc: '三个彩色圆点连成三角——表格、文档、画布三个能力彼此关联。白底上三个撞色点，远看也清晰。',
    inner: `
      ${BASE}
      <path d="M86 170 L128 84 L170 170 Z" fill="none" stroke="#C4CFEA" stroke-width="9" stroke-linejoin="round"/>
      <circle cx="86" cy="170" r="18" fill="#3A6DF0"/>
      <circle cx="170" cy="170" r="18" fill="#00B894"/>
      <circle cx="128" cy="84" r="18" fill="#FF7A29"/>`,
  },
  {
    key: 'F',
    file: 'F-四格点睛',
    name: '四格点睛',
    palette: ['#3A6DF0', '#FF7A29'],
    desc: '白底上的 2×2 圆角格，右上格跳成橙色——「表格里长出构想」。蓝格做了三档深浅，白底上更有层次。',
    inner: `
      ${BASE}
      <rect x="78" y="78" width="46" height="46" rx="14" fill="#3A6DF0"/>
      <rect x="132" y="78" width="46" height="46" rx="14" fill="#FF7A29"/>
      <rect x="78" y="132" width="46" height="46" rx="14" fill="#7E9DF5"/>
      <rect x="132" y="132" width="46" height="46" rx="14" fill="#B9CBFA"/>`,
  },
  {
    key: 'G',
    file: 'G-泡中星',
    name: '泡中星',
    palette: ['#3A6DF0', '#FFFFFF'],
    desc: '一个渐变蓝的对话泡，里面托一颗白色四角星——「说出想法」。有故事性，气质比其他方案更亲和。',
    inner: `
      <defs><linearGradient id="gG" x1="52" y1="72" x2="204" y2="204" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3A6DF0"/><stop offset="1" stop-color="#6C4CF1"/></linearGradient></defs>
      ${BASE}
      <rect x="52" y="72" width="152" height="98" rx="26" fill="url(#gG)"/>
      <path d="M84 170 L84 204 L122 170 Z" fill="#6C4CF1"/>
      <path d="M128 92 C132.5 110 141 118.5 159 123 C141 127.5 132.5 136 128 154 C123.5 136 115 127.5 97 123 C115 118.5 123.5 110 128 92 Z" fill="#FFFFFF"/>`,
  },
  {
    key: 'H',
    file: 'H-发射键',
    name: '发射键',
    palette: ['#3A6DF0', '#FF7A29'],
    desc: '蓝到橙渐变的圆角三角 + 白色圆孔，像按下「发射」——把构想推出去。渐变气质与参考图最接近。',
    inner: `
      <defs><linearGradient id="gH" x1="64" y1="70" x2="196" y2="190" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3A6DF0"/><stop offset="1" stop-color="#FF7A29"/></linearGradient></defs>
      ${BASE}
      <path d="M78 64 Q64 56 64 74 L64 182 Q64 200 78 192 L190 138 Q206 128 190 118 Z" fill="url(#gH)"/>
      <circle cx="112" cy="128" r="19" fill="#FFFFFF"/>`,
  },
];

const svgOf = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
${s.inner}
</svg>
`;

for (const s of schemes) {
  writeFileSync(join(OUT, `${s.file}.svg`), svgOf(s), 'utf8');
}

const cards = schemes
  .map(
    (s) => `    <div class="card">
      <span class="tag">${s.key}</span>
      <div class="stage"><img src="${encodeURIComponent(s.file)}.svg?v=5" alt="${s.name}"></div>
      <div class="name">${s.name}</div>
      <div class="palette">${s.palette
        .map((c) => `<span class="chip" style="background:${c}" title="${c}"></span>`)
        .join('')}<code>${s.palette.join(' / ')}</code></div>
      <div class="concept">${s.desc}</div>
      <div class="sizes">
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg?v=5" width="64" height="64"><span class="size-label">64</span></div>
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg?v=5" width="32" height="32"><span class="size-label">32</span></div>
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg?v=5" width="16" height="16"><span class="size-label">16</span></div>
      </div>
    </div>`
  )
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>构想工作台 · 图标候选 V5（白底彩笔）</title>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f7f9fc; color: #1f2329; padding: 48px 32px 80px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 600; margin-bottom: 8px; }
  .ref { background: #fff; border: 1px solid #e5e8ee; border-left: 4px solid #3A6DF0;
    border-radius: 10px; padding: 14px 18px; margin-bottom: 28px; font-size: 13px; line-height: 1.8; color: #444; }
  .ref b { color: #3A6DF0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; }
  .card { background: #fff; border: 1px solid #e5e8ee; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; }
  .tag { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    border-radius: 8px; background: #3A6DF0; color: #fff; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .stage { height: 190px; display: flex; align-items: center; justify-content: center;
    background: #3d4757; border-radius: 12px; margin-bottom: 12px; }
  .stage img { width: 150px; height: 150px; border-radius: 33px;
    filter: drop-shadow(0 6px 16px rgba(0,0,0,.35)); }
  .name { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .palette { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
  .chip { width: 16px; height: 16px; border-radius: 5px; border: 1px solid rgba(0,0,0,.08); }
  .palette code { font-size: 10.5px; color: #9aa0a8; margin-left: 4px; }
  .concept { font-size: 12.5px; color: #646a73; line-height: 1.65; margin-bottom: 12px; flex: 1; }
  .dark { background: #1a1f2b !important; }
  .sizes { display: flex; align-items: flex-end; gap: 14px; padding: 12px 14px 8px; background: #f7f9fc; border-radius: 10px; }
  .size-item { display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .size-label { font-size: 10px; color: #9aa0a8; }
</style>
</head>
<body>
<div class="wrap">
  <h1>构想工作台 · 图标候选 V5（白底彩笔）</h1>
  <p style="color:#9aa0a8;font-size:12px;margin:-4px 0 20px">生成于 2026-10-15 12:03 · 若与此处内容不符，请强制刷新（⌘⇧R）</p>
  <p class="ref">
    <b>骨架来自你给的参考图：</b>白色圆角底板 + 中央彩色圆头笔画图形（蓝→橙渐变、有动感）。保留骨架，只把中间图形换成构想工作台自己的意象。大图放在深色背景上模拟 Dock 实际观感。
  </p>
  <div class="grid">
${cards}
  </div>
</div>
</body>
</html>
`;

writeFileSync(join(OUT, 'index.html'), html, 'utf8');
console.log('generated', schemes.length, '->', OUT);

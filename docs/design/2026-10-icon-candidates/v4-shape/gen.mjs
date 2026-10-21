// V4：无方块底板，图形自身外形即识别点；每方案 2–3 个形状，撞色
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const schemes = [
  {
    key: 'A',
    file: 'A-咬合',
    name: '圆 咬 方',
    palette: ['#1B3FD8', '#FF7A29'],
    desc: '蓝色圆被橙色圆角方块压住一角，两个形状互相咬合形成整体轮廓。外形不规整，在 Dock 里最不容易跟别人撞。',
    inner: `
      <circle cx="104" cy="128" r="76" fill="#1B3FD8"/>
      <rect x="118" y="90" width="88" height="88" rx="24" fill="#FF7A29"/>`,
  },
  {
    key: 'B',
    file: 'B-四瓣',
    name: '四瓣',
    palette: ['#3A6DF0', '#FFC53D'],
    desc: '四个圆叠成花瓣，中心一颗金色圆核。有机曲线轮廓，在一堆直角图标里最柔、最好认。',
    inner: `
      <circle cx="128" cy="90" r="38" fill="#3A6DF0"/>
      <circle cx="166" cy="128" r="38" fill="#3A6DF0"/>
      <circle cx="128" cy="166" r="38" fill="#3A6DF0"/>
      <circle cx="90" cy="128" r="38" fill="#3A6DF0"/>
      <circle cx="128" cy="128" r="24" fill="#FFC53D"/>`,
  },
  {
    key: 'C',
    file: 'C-水滴',
    name: '水滴切分',
    palette: ['#14213D', '#35F0D0'],
    desc: '一滴水被腰线切成墨黑与荧光青。尖顶有机形，暗色界面上荧光青会发光，辨识度极高。',
    inner: `
      <clipPath id="clipC"><path d="M128 44 C176 96 202 128 202 158 A74 74 0 0 1 54 158 C54 128 80 96 128 44 Z"/></clipPath>
      <g clip-path="url(#clipC)">
        <polygon points="40,40 216,40 40,216" fill="#35F0D0"/>
        <polygon points="216,40 216,216 40,216" fill="#14213D"/>
      </g>`,
  },
  {
    key: 'D',
    file: 'D-六边',
    name: '六边切分',
    palette: ['#FF7A29', '#14213D'],
    desc: '正六边形沿对角切成橙与墨黑。几何硬朗、切面对比强，是这一批里最「工业设计感」的一个。',
    inner: `
      <clipPath id="clipD"><polygon points="212,128 170,200 86,200 44,128 86,56 170,56"/></clipPath>
      <g clip-path="url(#clipD)">
        <polygon points="40,50 216,50 40,206" fill="#FF7A29"/>
        <polygon points="216,50 216,206 40,206" fill="#14213D"/>
      </g>`,
  },
  {
    key: 'E',
    file: 'E-十字块',
    name: '十字块',
    palette: ['#6C4CF1', '#17E0A0'],
    desc: '一个粗十字托着中心的青色方块——「往里加东西 / 构建」。紫 × 青的撞色最年轻，十字外形在 Dock 里极少见。',
    inner: `
      <rect x="100" y="44" width="56" height="168" rx="14" fill="#6C4CF1"/>
      <rect x="44" y="100" width="168" height="56" rx="14" fill="#6C4CF1"/>
      <rect x="104" y="104" width="48" height="48" rx="12" fill="#17E0A0"/>`,
  },
  {
    key: 'F',
    file: 'F-阶梯山',
    name: '阶梯山',
    palette: ['#00B894', '#FF6B6B'],
    desc: '三级方块沿对角线抬升，顶端换成珊瑚色。轮廓像座小山，自带「一层层搭起来 / 向上」的动势。',
    inner: `
      <rect x="56" y="144" width="56" height="56" rx="16" fill="#00B894"/>
      <rect x="100" y="100" width="56" height="56" rx="16" fill="#00B894" opacity="0.7"/>
      <rect x="144" y="56" width="56" height="56" rx="16" fill="#FF6B6B"/>`,
  },
  {
    key: 'G',
    file: 'G-圆柱',
    name: '数据圆柱',
    palette: ['#1E3FCC', '#FF5A5F'],
    desc: '半圆顶扣一个圆角块，就是经典的「数据库圆柱」剪影，直接呼应 gouxiangdb 的库。深蓝 × 珊瑚，稳重又跳。',
    inner: `
      <path d="M56 136 A72 72 0 0 1 200 136 Z" fill="#1E3FCC"/>
      <path d="M56 136 H200 V180 A28 28 0 0 1 172 208 H84 A28 28 0 0 1 56 180 Z" fill="#FF5A5F"/>`,
  },
  {
    key: 'H',
    file: 'H-开口环',
    name: '开口环',
    palette: ['#3A6DF0', '#FF7A29'],
    desc: '一道粗环留了个缺口，缺口处跳出一块橙色方块——「从环里跑出来的东西」，最貼「构想」的意象。',
    inner: `
      <circle cx="128" cy="128" r="72" fill="none" stroke="#3A6DF0" stroke-width="26"
        stroke-dasharray="360 92.4" transform="rotate(-118 128 128)"/>
      <rect x="146" y="76" width="40" height="40" rx="12" fill="#FF7A29"/>`,
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
      <div class="stage"><img src="${encodeURIComponent(s.file)}.svg" alt="${s.name}"></div>
      <div class="name">${s.name}</div>
      <div class="palette">${s.palette
        .map((c) => `<span class="chip" style="background:${c}" title="${c}"></span>`)
        .join('')}<code>${s.palette.join(' / ')}</code></div>
      <div class="concept">${s.desc}</div>
      <div class="sizes">
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg" width="64" height="64"><span class="size-label">64</span></div>
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg" width="32" height="32"><span class="size-label">32</span></div>
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg" width="16" height="16"><span class="size-label">16</span></div>
      </div>
    </div>`
  )
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>构想工作台 · 图标候选 V4（异形无底板）</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f7f9fc; color: #1f2329; padding: 48px 32px 80px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 600; margin-bottom: 8px; }
  .diff { background: #fff; border: 1px solid #e5e8ee; border-left: 4px solid #FF7A29;
    border-radius: 10px; padding: 14px 18px; margin-bottom: 28px; font-size: 13px; line-height: 1.8; color: #444; }
  .diff b { color: #1B3FD8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; }
  .card { background: #fff; border: 1px solid #e5e8ee; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; }
  .tag { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    border-radius: 8px; background: #1B3FD8; color: #fff; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .stage { height: 190px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(45deg,#f0f2f5 25%,transparent 25%,transparent 75%,#f0f2f5 75%) 0 0/20px 20px,
      linear-gradient(45deg,#f0f2f5 25%,transparent 25%,transparent 75%,#f0f2f5 75%) 10px 10px/20px 20px, #fff;
    border-radius: 12px; margin-bottom: 12px; }
  .stage img { width: 150px; height: 150px; }
  .name { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .palette { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
  .chip { width: 16px; height: 16px; border-radius: 5px; border: 1px solid rgba(0,0,0,.08); }
  .palette code { font-size: 10.5px; color: #9aa0a8; margin-left: 4px; }
  .concept { font-size: 12.5px; color: #646a73; line-height: 1.65; margin-bottom: 12px; flex: 1; }
  .sizes { display: flex; align-items: flex-end; gap: 14px; padding: 12px 14px 8px; background: #f7f9fc; border-radius: 10px; }
  .size-item { display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .size-label { font-size: 10px; color: #9aa0a8; }
</style>
</head>
<body>
<div class="wrap">
  <h1>构想工作台 · 图标候选 V4（异形 · 无底板）</h1>
  <p class="diff">
    <b>与前三批的根本区别：</b>去掉了「圆角方块底板 + 居中符号」这个骨架——八个图形的<b>外轮廓各不相同</b>（咬合圆、花瓣、水滴、六边形、十字、阶梯山、圆柱、开口环），没有一个是方方正正的底托。仍是手写 SVG，每方案 2–3 个形状，双色撞色。
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

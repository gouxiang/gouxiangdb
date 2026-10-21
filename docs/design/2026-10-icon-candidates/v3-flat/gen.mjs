// 生成 v3 极简撞色图标方案：SVG 源文件 + 对比预览页
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

// 每个方案：一个纯色圆角底 + 居中符号（≤3 个几何形状），配色撞色
const schemes = [
  {
    key: 'A',
    file: 'A-折角块',
    name: '折角块',
    bg: '#1B3FD8',
    palette: ['#1B3FD8', '#FFFFFF', '#FF7A29'],
    desc: '深蓝底 + 白色圆角方块，右上角翻起一片橙色折角——「一张被翻开的卡片」。蓝 × 橙互补撞色，最跳眼。',
    inner: `
      <path d="M92 68 H148 L172 92 V148 A24 24 0 0 1 148 172 H92 A24 24 0 0 1 68 148 V92 A24 24 0 0 1 92 68 Z" fill="#FFFFFF"/>
      <path d="M148 68 L172 92 L148 92 Z" fill="#FF7A29"/>`,
  },
  {
    key: 'B',
    file: 'B-错位双块',
    name: '错位双块',
    bg: '#3A6DF0',
    palette: ['#3A6DF0', '#FF7A29', '#FFFFFF'],
    desc: '两块圆角方块错位叠放，前橙后白半透——「两层结构 / 叠加能力」。靛蓝 × 橙撞色，层次感来自错位而非透视。',
    inner: `
      <rect x="70" y="70" width="96" height="96" rx="22" fill="#FFFFFF" opacity="0.55"/>
      <rect x="90" y="90" width="96" height="96" rx="22" fill="#FF7A29"/>`,
  },
  {
    key: 'C',
    file: 'C-一格点睛',
    name: '一格点睛',
    bg: '#1E3FCC',
    palette: ['#1E3FCC', '#FFFFFF', '#FFC53D'],
    desc: '2×2 四格里右上角换成金色——「表格里长出一个想法」。深蓝 × 金，克制但记忆点最强。',
    inner: `
      <rect x="78" y="78" width="44" height="44" rx="13" fill="#FFFFFF"/>
      <rect x="134" y="78" width="44" height="44" rx="13" fill="#FFC53D"/>
      <rect x="78" y="134" width="44" height="44" rx="13" fill="#FFFFFF"/>
      <rect x="134" y="134" width="44" height="44" rx="13" fill="#FFFFFF"/>`,
  },
  {
    key: 'D',
    file: 'D-点线',
    name: '点 与 线',
    bg: '#00B894',
    palette: ['#00B894', '#FF6B6B', '#FFFFFF'],
    desc: '一个珊瑚橙圆点压两条白线——「数据点 + 记录行」。青绿 × 珊瑚撞色，安静底色上一点跳脱。',
    inner: `
      <circle cx="128" cy="100" r="26" fill="#FF6B6B"/>
      <rect x="84" y="142" width="88" height="14" rx="7" fill="#FFFFFF"/>
      <rect x="84" y="166" width="52" height="14" rx="7" fill="#FFFFFF" opacity="0.65"/>`,
  },
  {
    key: 'E',
    file: 'E-对角切',
    name: '对角切分',
    bg: '#14213D',
    palette: ['#14213D', '#35F0D0', '#FFFFFF'],
    desc: '一个圆角方块被对角线切成荧光青与纯白两半——「两种形态一体两面」。墨黑 × 霓虹青，暗色里最亮眼。',
    inner: `
      <clipPath id="clipE"><rect x="68" y="68" width="120" height="120" rx="28"/></clipPath>
      <g clip-path="url(#clipE)">
        <polygon points="68,68 188,68 68,188" fill="#35F0D0"/>
        <polygon points="188,68 188,188 68,188" fill="#FFFFFF"/>
      </g>`,
  },
  {
    key: 'F',
    file: 'F-阶梯',
    name: '三级阶梯',
    bg: '#6C4CF1',
    palette: ['#6C4CF1', '#17E0A0', '#FFFFFF'],
    desc: '三个方块沿对角线逐级升高，顶端换成青绿——「一步步搭起来」。紫 × 青撞色，自带向上动势。',
    inner: `
      <rect x="68" y="144" width="44" height="44" rx="14" fill="#FFFFFF"/>
      <rect x="106" y="106" width="44" height="44" rx="14" fill="#FFFFFF" opacity="0.75"/>
      <rect x="144" y="68" width="44" height="44" rx="14" fill="#17E0A0"/>`,
  },
  {
    key: 'G',
    file: 'G-嵌菱',
    name: '方块嵌菱',
    bg: '#FF7A29',
    palette: ['#FF7A29', '#FFFFFF', '#1B3FD8'],
    desc: '橙底托一个白色圆角方块，方块内嵌一枚深蓝菱形——「结构里有个内核」。橙 × 蓝，纯度最高的互补撞色。',
    inner: `
      <rect x="68" y="68" width="120" height="120" rx="28" fill="#FFFFFF"/>
      <polygon points="128,86 170,128 128,170 86,128" fill="#1B3FD8"/>`,
  },
  {
    key: 'H',
    file: 'H-环点',
    name: '环 与 核',
    bg: '#FF5A5F',
    palette: ['#FF5A5F', '#FFFFFF', '#14213D'],
    desc: '一道白色粗环围住中心的墨色小方块——「工作台围着一坨数据」。珊瑚红 × 墨黑，暖底冷核反差。',
    inner: `
      <circle cx="128" cy="128" r="42" fill="none" stroke="#FFFFFF" stroke-width="22"/>
      <rect x="112" y="112" width="32" height="32" rx="9" fill="#14213D"/>`,
  },
];

const svgOf = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="57" fill="${s.bg}"/>
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
<title>构想工作台 · 图标候选 V3（极简撞色）</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f7f9fc; color: #1f2329; padding: 48px 32px 80px;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 600; margin-bottom: 8px; }
  .sub { color: #646a73; font-size: 14px; margin-bottom: 8px; line-height: 1.8; }
  .rule { color: #3A6DF0; font-size: 13px; margin-bottom: 36px; line-height: 1.8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; }
  .card { background: #fff; border: 1px solid #e5e8ee; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; }
  .tag { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    border-radius: 8px; background: #3A6DF0; color: #fff; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
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
  <h1>构想工作台 · 图标候选 V3（极简撞色）</h1>
  <p class="sub">全部为手写 SVG 矢量，非 AI 生图，因此没有多余的透视、阴影和场景细节。</p>
  <p class="rule">规则：<b>圆角方块纯色底 + 居中符号，每个方案只有 2–3 个几何形状</b>；底色与符号刻意撞色（蓝×橙、紫×青、墨×荧光青、珊瑚×墨）。</p>
  <div class="grid">
${cards}
  </div>
</div>
</body>
</html>
`;

writeFileSync(join(OUT, 'index.html'), html, 'utf8');
console.log('generated', schemes.length, 'icons ->', OUT);

// V6：纸白珠光底板 + 光泽 + 多段色差缓融色带 + 方形字母 G（内含两道文档横杠）
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

// —— 底板：类纸白 + 珠光 + 光泽（所有变体共用）——
const plate = (id) => `
  <defs>
    <linearGradient id="paper${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.38" stop-color="#FDFBF5"/>
      <stop offset="0.72" stop-color="#F7F4EC"/>
      <stop offset="1" stop-color="#FFFDF8"/>
    </linearGradient>
    <linearGradient id="pearl${id}" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#FFE4EE" stop-opacity="0.55"/>
      <stop offset="0.28" stop-color="#FFF4D6" stop-opacity="0.30"/>
      <stop offset="0.52" stop-color="#E2F2FF" stop-opacity="0.50"/>
      <stop offset="0.76" stop-color="#ECE6FF" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0.65"/>
    </linearGradient>
    <linearGradient id="gloss${id}" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/>
      <stop offset="0.42" stop-color="#FFFFFF" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="sheen${id}" cx="0.32" cy="0.22" r="0.62">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.95"/>
      <stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="256" height="256" rx="57" fill="url(#paper${id})"/>
  <rect width="256" height="256" rx="57" fill="url(#pearl${id})"/>
  <rect width="256" height="256" rx="57" fill="url(#gloss${id})"/>
  <rect width="256" height="256" rx="57" fill="url(#sheen${id})"/>
  <rect x="0.8" y="0.8" width="254.4" height="254.4" rx="56.4" fill="none" stroke="#E6E0D5" stroke-opacity="0.85" stroke-width="1.6"/>
  <rect x="3" y="3" width="250" height="250" rx="54" fill="none" stroke="#FFFFFF" stroke-opacity="0.75" stroke-width="2"/>`;

// —— 色带：明确的色差分块 + 缓慢融合（橙黄 → 橘黄 → 深蓝 → 浅蓝）——
const band = (id, x1, y1, x2, y2) => `
    <linearGradient id="band${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFC93D"/>
      <stop offset="0.14" stop-color="#FFB52A"/>
      <stop offset="0.27" stop-color="#FF8A1F"/>
      <stop offset="0.34" stop-color="#FF7A29"/>
      <stop offset="0.42" stop-color="#F2622B"/>
      <stop offset="0.52" stop-color="#6A46C8"/>
      <stop offset="0.60" stop-color="#1B3FD8"/>
      <stop offset="0.72" stop-color="#2450E8"/>
      <stop offset="0.84" stop-color="#3A6DF0"/>
      <stop offset="0.93" stop-color="#77A6F7"/>
      <stop offset="1" stop-color="#A9D2FF"/>
    </linearGradient>`;

// —— 方形 G：圆角矩形环开口在右侧 + 收笔横杠 + 两道文档横杠 ——
// 单条连续路径：方框环（Q 圆角）→ 右直边上行 → 内拐的长横杠（同时充当 G 的收笔与文档末行）
const gMark = (id, { c = 26, w = 28, bars = 1 }) => {
  const A = 74;
  const B = 182;
  const d = [
    `M ${B} 112`,
    `L ${B} ${A + c}`,
    `Q ${B} ${A} ${B - c} ${A}`,
    `L ${A + c} ${A}`,
    `Q ${A} ${A} ${A} ${A + c}`,
    `L ${A} ${B - c}`,
    `Q ${A} ${B} ${A + c} ${B}`,
    `L ${B - c} ${B}`,
    `Q ${B} ${B} ${B} ${B - c}`,
    `L ${B} 142`,
    `L 104 142`,
  ].join(' ');
  const docBars =
    bars === 1
      ? `
      <line x1="98" y1="112" x2="146" y2="112" stroke="url(#band${id})" stroke-width="11" stroke-linecap="round"/>`
      : `
      <line x1="98" y1="104" x2="146" y2="104" stroke="url(#band${id})" stroke-width="11" stroke-linecap="round"/>
      <line x1="98" y1="124" x2="126" y2="124" stroke="url(#band${id})" stroke-width="11" stroke-linecap="round"/>`;
  return `
      <path d="${d}" fill="none" stroke="url(#band${id})" stroke-width="${w}"
        stroke-linecap="round" stroke-linejoin="round"/>${docBars}`;
};

const schemes = [
  {
    key: 'A',
    file: 'A-斜向色带',
    name: '斜向色带',
    desc: '色带自左上向右下流淌：橙黄起笔 → 橘黄 → 深蓝 → 浅蓝收尾。G 为偏方形（圆角 34），右下收笔，内部两道文档横杠。',
    svg: (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  ${plate(id)}
  <defs>${band(id, 62, 58, 198, 196)}</defs>${gMark(id, { c: 34, w: 28, bars: 1 })}
</svg>
`,
  },
  {
    key: 'B',
    file: 'B-竖向色带',
    name: '竖向色带',
    desc: '色带自上而下：顶部橙黄，往下转橘黄、深蓝，底部浅蓝。G 更方硬（圆角 24），整体气质最利落。',
    svg: (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  ${plate(id)}
  <defs>${band(id, 128, 56, 128, 200)}</defs>${gMark(id, { c: 24, w: 28, bars: 1 })}
</svg>
`,
  },
  {
    key: 'C',
    file: 'C-横向色带',
    name: '横向色带 三道杠',
    desc: '色带自左向右：左侧橙黄，右侧蓝。文档横杠加到三道，文本行的意象更足，也更像一个「文档型数据库」。',
    svg: (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  ${plate(id)}
  <defs>${band(id, 58, 128, 200, 128)}</defs>${gMark(id, { c: 30, w: 27, bars: 2 })}
</svg>
`,
  },
  {
    key: 'D',
    file: 'D-反向色带',
    name: '反向色带 厚笔',
    desc: '色带自右上向左下，笔画加粗到 32，色差块面更大更壮。视觉最重、最有存在感，适合小尺寸下也压得住。',
    svg: (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  ${plate(id)}
  <defs>${band(id, 200, 58, 62, 198)}</defs>${gMark(id, { c: 32, w: 32, bars: 1 })}
</svg>
`,
  },
  {
    key: 'E',
    file: 'E-方形G斜向',
    name: '方形 G · 斜向',
    desc: '圆角收到 22（笔画 26），G 基本是方框了，只在转角留一点柔化。配斜向色带，最接近「方块感 + 文档」的诉求。',
    svg: (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  ${plate(id)}
  <defs>${band(id, 62, 58, 198, 196)}</defs>${gMark(id, { c: 22, w: 26, bars: 1 })}
</svg>
`,
  },
  {
    key: 'F',
    file: 'F-方形G竖向',
    name: '方形 G · 竖向',
    desc: '圆角 22、笔画 28，竖向色带（顶橙黄 → 底浅蓝）。最方、最重、最像一枚「印章」的版本。',
    svg: (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  ${plate(id)}
  <defs>${band(id, 128, 56, 128, 200)}</defs>${gMark(id, { c: 22, w: 28, bars: 1 })}
</svg>
`,
  },
];

for (const s of schemes) {
  const id = s.key.toLowerCase();
  writeFileSync(join(OUT, `${s.file}.svg`), s.svg(id), 'utf8');
}

const cards = schemes
  .map(
    (s) => `    <div class="card">
      <span class="tag">${s.key}</span>
      <div class="stage"><img src="${encodeURIComponent(s.file)}.svg?v=6" alt="${s.name}"></div>
      <div class="name">${s.name}</div>
      <div class="concept">${s.desc}</div>
      <div class="sizes dark">
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg?v=6" width="64" height="64"><span class="size-label">64</span></div>
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg?v=6" width="32" height="32"><span class="size-label">32</span></div>
        <div class="size-item"><img src="${encodeURIComponent(s.file)}.svg?v=6" width="16" height="16"><span class="size-label">16</span></div>
      </div>
    </div>`
  )
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>构想工作台 · 图标 V6（纸白珠光 · 方形 G）</title>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f2f4f8; color: #1f2329; padding: 48px 32px 80px; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 600; margin-bottom: 6px; }
  .stamp { color: #9aa0a8; font-size: 12px; margin-bottom: 10px; }
  .spec { background: #fff; border: 1px solid #e5e8ee; border-left: 4px solid #FF7A29;
    border-radius: 10px; padding: 14px 18px; margin-bottom: 28px; font-size: 13px; line-height: 1.9; color: #444; }
  .spec b { color: #1B3FD8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
  .card { background: #fff; border: 1px solid #e5e8ee; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; }
  .tag { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    border-radius: 8px; background: #1B3FD8; color: #fff; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .stage { height: 200px; display: flex; align-items: center; justify-content: center;
    background: #dfe4ec; border-radius: 12px; margin-bottom: 12px; }
  .stage img { width: 168px; height: 168px; border-radius: 37px; filter: drop-shadow(0 8px 18px rgba(20,30,60,.18)); }
  .name { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .concept { font-size: 12.5px; color: #646a73; line-height: 1.65; margin-bottom: 12px; flex: 1; }
  .sizes { display: flex; align-items: flex-end; gap: 14px; padding: 12px 14px 8px; background: #f7f9fc; border-radius: 10px; }
  .sizes.dark { background: #232a38; }
  .sizes.dark .size-label { color: #7d8798; }
  .size-item { display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .size-label { font-size: 10px; color: #9aa0a8; }
</style>
</head>
<body>
<div class="wrap">
  <h1>构想工作台 · 图标 V6（纸白珠光 · 方形 G）</h1>
  <p class="stamp">生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })} · 若内容不符请强制刷新（⌘⇧R）</p>
  <p class="spec">
    <b>底板</b>：类纸白（暖调 #FDFBF5 系）+ 珠光层（极淡的粉 / 暖黄 / 青 / 紫微光）+ 斜向光泽高光与内圈亮边。<br>
    <b>色带</b>：橙黄 → 橘黄 → 深蓝 → 浅蓝，多段明显色差、段间缓慢融合，不是平滑渐变。<br>
    <b>图形</b>：偏方形字母 G（非圆润），中间加两道横杠模拟文本文档。
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

// V7：复刻参考图标的色彩过渡方式 —— 完整暖→冷色序（橙黄→橙→玫红→紫→蓝→亮蓝），平滑过渡
// 形状统一用方形 G（取自 V6-E 的参数），只变渐变轴向与 stop 密度
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

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

// 参考图色序：橙黄 → 橙 → 玫红 → 紫 → 蓝 → 亮蓝（平滑）
const REF_STOPS = `
      <stop offset="0" stop-color="#F7A81B"/>
      <stop offset="0.18" stop-color="#F5841F"/>
      <stop offset="0.38" stop-color="#E8447A"/>
      <stop offset="0.56" stop-color="#7B4CD8"/>
      <stop offset="0.78" stop-color="#2C7BE5"/>
      <stop offset="1" stop-color="#29B6F6"/>`;

// 同色序但 stop 更密（带一点色块感）
const REF_STOPS_DENSE = `
      <stop offset="0" stop-color="#F7A81B"/>
      <stop offset="0.12" stop-color="#F59A1E"/>
      <stop offset="0.26" stop-color="#EE6A35"/>
      <stop offset="0.38" stop-color="#E8447A"/>
      <stop offset="0.48" stop-color="#BE45A8"/>
      <stop offset="0.56" stop-color="#7B4CD8"/>
      <stop offset="0.68" stop-color="#4A6EE8"/>
      <stop offset="0.78" stop-color="#2C7BE5"/>
      <stop offset="0.9" stop-color="#3AA6EE"/>
      <stop offset="1" stop-color="#29B6F6"/>`;

const band = (id, x1, y1, x2, y2, stops = REF_STOPS) => `
    <linearGradient id="band${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">${stops}
    </linearGradient>`;

const gMark = (id, { c = 22, w = 26, bars = 1 }) => {
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
  const docBars = `
      <line x1="98" y1="112" x2="146" y2="112" stroke="url(#band${id})" stroke-width="11" stroke-linecap="round"/>`;
  return `
      <path d="${d}" fill="none" stroke="url(#band${id})" stroke-width="${w}"
        stroke-linecap="round" stroke-linejoin="round"/>${docBars}`;
};

const head = (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  ${plate(id)}
  <defs>`;

const schemes = [
  {
    key: 'A',
    file: 'A-陡斜轴',
    name: '陡斜轴',
    desc: '渐变轴自左上偏垂直向下（约 62°），完整暖→冷色序：橙黄 → 橙 → 玫红 → 紫 → 蓝 → 亮蓝，平滑过渡。参考图同款逻辑。',
    svg: (id) => `${head(id)}${band(id, 76, 56, 174, 206)}
  </defs>${gMark(id, { c: 22, w: 26 })}
</svg>
`,
  },
  {
    key: 'B',
    file: 'B-对角轴',
    name: '对角轴 45°',
    desc: '经典 45° 对角渐变，左上橙黄、右下亮蓝，中途经玫红与紫。色彩在图形里斜向流动，最像参考图的观感。',
    svg: (id) => `${head(id)}${band(id, 62, 62, 194, 194)}
  </defs>${gMark(id, { c: 22, w: 26 })}
</svg>
`,
  },
  {
    key: 'C',
    file: 'C-垂直轴',
    name: '垂直轴',
    desc: '正上到下：顶端橙黄，经橙、玫红、紫，底端亮蓝。色相沿垂直方向完整铺开，最接近参考图单笔内部的变化。',
    svg: (id) => `${head(id)}${band(id, 128, 58, 128, 198)}
  </defs>${gMark(id, { c: 22, w: 26 })}
</svg>
`,
  },
  {
    key: 'D',
    file: 'D-密stop带块感',
    name: '密 stop（带分块感）',
    desc: '同样色序，但用 10 个更密的色标，让暖→冷之间能看出几个色阶块，介于“平滑”与“分块”之间。',
    svg: (id) => `${head(id)}${band(id, 62, 62, 194, 194, REF_STOPS_DENSE)}
  </defs>${gMark(id, { c: 22, w: 26 })}
</svg>
`,
  },
];

for (const s of schemes) {
  writeFileSync(join(OUT, `${s.file}.svg`), s.svg(s.key.toLowerCase()), 'utf8');
}

console.log('generated', schemes.length, '->', OUT);

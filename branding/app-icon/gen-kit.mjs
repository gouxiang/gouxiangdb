// 定稿版图标：V7-A 陡斜轴（像素比对判定，与戴总截图关键点色差最小）
// 输出圆角版（web/Android/iOS 直接用）与满出血方角版（macOS 交给系统裁圆角）
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'svg');
mkdirSync(OUT, { recursive: true });

const id = 'k';

// 参考图色序：橙黄 → 橙 → 玫红 → 紫 → 蓝 → 亮蓝
const BAND = `
      <stop offset="0" stop-color="#F7A81B"/>
      <stop offset="0.18" stop-color="#F5841F"/>
      <stop offset="0.38" stop-color="#E8447A"/>
      <stop offset="0.56" stop-color="#7B4CD8"/>
      <stop offset="0.78" stop-color="#2C7BE5"/>
      <stop offset="1" stop-color="#29B6F6"/>`;

const paper = (rx, extra) => `
      <rect width="256" height="256" rx="${rx}" fill="url(#paper${id})"/>
      <rect width="256" height="256" rx="${rx}" fill="url(#pearl${id})"/>
      <rect width="256" height="256" rx="${rx}" fill="url(#gloss${id})"/>
      <rect width="256" height="256" rx="${rx}" fill="url(#sheen${id})"/>${extra}`;

const defs = (rx) => `
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
    <linearGradient id="band${id}" x1="76" y1="56" x2="174" y2="206" gradientUnits="userSpaceOnUse">${BAND}
    </linearGradient>
  </defs>`;

const mark = `
  <path d="M 182 112 L 182 96 Q 182 74 160 74 L 96 74 Q 74 74 74 96 L 74 160 Q 74 182 96 182 L 160 182 Q 182 182 182 160 L 182 142 L 104 142"
    fill="none" stroke="url(#band${id})" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="98" y1="112" x2="146" y2="112" stroke="url(#band${id})" stroke-width="11" stroke-linecap="round"/>`;

// 圆角版：自带圆角 + 内外描边（web / Android / iOS / 通用 PNG）
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="1024" height="1024">
${defs(57)}
${paper(57, `
      <rect x="0.8" y="0.8" width="254.4" height="254.4" rx="56.4" fill="none" stroke="#E6E0D5" stroke-opacity="0.85" stroke-width="1.6"/>
      <rect x="3" y="3" width="250" height="250" rx="54" fill="none" stroke="#FFFFFF" stroke-opacity="0.75" stroke-width="2"/>`)}
${mark}
</svg>
`;

// 满出血方角版：四角不留圆角，交给 macOS / Windows 系统裁切
const fullbleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="1024" height="1024">
${defs(0)}
${paper(0, '')}
${mark}
</svg>
`;

writeFileSync(join(OUT, 'icon.svg'), rounded, 'utf8');
writeFileSync(join(OUT, 'icon-fullbleed.svg'), fullbleed, 'utf8');
console.log('svg written ->', OUT);

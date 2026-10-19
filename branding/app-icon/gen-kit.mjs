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

// macOS 主图形：G 标志居中放大（2026-10-18 戴总反馈「图案太小」）。
// 原 mark 视觉边界约 61..195（占 256 画布 ~52%）；以中心(128,128)等比放大 1.4 倍后
// 边界约 34..222（~73%，与微信等主流 App 主图形占比接近）。stroke-width 随 transform
// 同比加粗（26→36.4、11→15.4），整体更敦实。通用圆角版仍用未缩放的 ${mark}。
const MAC_MARK_SCALE = 1.4;
const markMac = `
  <g transform="translate(128 128) scale(${MAC_MARK_SCALE}) translate(-128 -128)">${mark}
  </g>`;

// macOS 图标网格（2026-10-18 戴总反馈「图标比别的 App 肥大一圈」返工）。
// Apple Big Sur 起官方模板：1024 画布上底板为 824×824、居中、四周安全边各 100
// （底板占 824/1024 ≈ 80.47%，安全边 100/1024 ≈ 9.77%）。映射到 256 逻辑坐标：
// 底板边长 206、inset 25。做法＝把上一版「铺满 256 的白牌 + 放大 G」整组同比缩
// 0.8046875 再平移 25，于是 G 相对白牌占比逐像素保持 ~73.4%（戴总已认可的敦实度），
// 只是整组缩入网格、四周留白，Dock 中不再比微信等满网格图标「肥大一圈」。
// 底板超椭圆圆角在 build-kit.py 用 PIL 单一 alpha 遮罩按底板矩形裁出（不由 SVG 自带）。
const MAC_TILE_SCALE = 824 / 1024;   // 0.8046875
const MAC_INSET = (256 * 100) / 1024; // 25

// 圆角版：自带圆角 + 内外描边（web / Android / iOS / 通用 PNG）
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="1024" height="1024">
${defs(57)}
${paper(57, `
      <rect x="0.8" y="0.8" width="254.4" height="254.4" rx="56.4" fill="none" stroke="#E6E0D5" stroke-opacity="0.85" stroke-width="1.6"/>
      <rect x="3" y="3" width="250" height="250" rx="54" fill="none" stroke="#FFFFFF" stroke-opacity="0.75" stroke-width="2"/>`)}
${mark}
</svg>
`;

// macOS 网格母版：白牌 + 放大 G（markMac）整组同比缩入 Apple 图标网格（见上 MAC_TILE_SCALE /
// MAC_INSET），四周留安全边、不再满出血。Big Sur 起 App 图标的超椭圆圆角由图标自身承担，
// 而 qlmanage 渲染 SVG 会把透明角压平成白底，故**圆角遮罩在 build-kit.py 里用 PIL 单一超椭圆
// alpha 遮罩按底板矩形裁出**（半径 ≈22.45% 底板边长），避免「自带圆角再被裁」的双重圆角白晕。
const mac = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="1024" height="1024">
${defs(0)}
  <g transform="translate(${MAC_INSET} ${MAC_INSET}) scale(${MAC_TILE_SCALE})">
${paper(0, '')}
${markMac}
  </g>
</svg>
`;

writeFileSync(join(OUT, 'icon.svg'), rounded, 'utf8');
writeFileSync(join(OUT, 'icon-mac.svg'), mac, 'utf8');
console.log('svg written ->', OUT);

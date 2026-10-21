// 工作区外壳几何常量（2026-10 UI 重做 v6 起）。
//
// 历史：阶段 1 壳层时 L1 有 196/56 两档（折叠态写 localStorage gx.l1.collapsed）。
// v6 底板把 L1 定为恒定 76px 的「图标轨」（docs/design/2026-10-ui-redesign/actual/v6
// /src/shared.css .rail，72–82 行），折叠档永久废止：L1_COLLAPSED_KEY /
// L1_WIDTH_EXPANDED / L1_WIDTH_COLLAPSED / readL1Collapsed / writeL1Collapsed
// 已全部删除。
// v6 S2：L2 同步底板 .l2（同文件 337–345 行）恒定 236px，1280–1439 的 208 紧凑档
// （L2_WIDTH_COMPACT）一并废止，本模块只保留外壳各区域的几何尺寸单一真源。

/** L1 图标轨恒定宽度（底板 .rail width:76px）。 */
export const L1_WIDTH = 76;

/** L2 二级面板恒定宽度（底板 .l2 width:236px；v6 S2 起不分档）。无二级内容时为 0（不占位）。 */
export const L2_WIDTH = 236;

/** 顶栏高度（骨架 S-1；与底板 .topbar 56px 一致）。 */
export const TOPBAR_H = 56;

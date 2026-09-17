// scripts/acceptance/lib/lcg.mjs
// 确定性伪随机（LCG，选种 42）：与 M4 s10-ac-upgrade-20x20 / M2 s8 同一参数，
// 保证播种内容在任意机器上逐字节可复现（记录值、附件字节、画布坐标、主体选样）。
//
// 纯函数模块，无 IO、无副作用，单文件单一职责。

export const DEFAULT_SEED = 42;

/**
 * 数值 LCG：s = s*1664525 + 1013904223 (mod 2^32)。
 * 返回一个取数函数，每次产出 [0,1) 浮点。
 * @param {number} seed
 */
export function makeRng(seed = DEFAULT_SEED) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 确定性整数 [min, max]（含两端）。
 * @param {() => number} rng
 */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 按概率命中（rng() < p）。
 * @param {() => number} rng
 * @param {number} p
 */
export function chance(rng, p) {
  return rng() < p;
}

/**
 * 从数组确定性挑一个。
 * @template T
 * @param {() => number} rng
 * @param {readonly T[]} arr
 * @returns {T}
 */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * 生成确定性字节缓冲（LCG 逐字节，附件 sha256 可复现）。
 * 不要用 Math.random/crypto（不可复现）。
 * @param {() => number} rng
 * @param {number} length
 */
export function randomBytes(rng, length) {
  const buf = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) buf[i] = Math.floor(rng() * 256);
  return buf;
}

/**
 * 确定性可打印字符串（用于长文/长 URL/多字节混合）。
 * @param {() => number} rng
 * @param {number} length
 */
export function randomText(rng, length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

// apps/api/scripts/bench/gen/prng.ts
// M1/S9 压测数据生成的确定性随机源（mulberry32）与全局确定性 id 序列。
//
// 同一 --seed 必须逐字节复现同一套库（A/B 与重跑可复现）：
//   - 禁止 Math.random / Date.now / cuid / 随机 bcrypt 盐；
//   - 随机一律走可种子 Rng；
//   - 所有实体 id（base/user/table/field/view/record/link_row）一律走全局自增 seqId，
//     跨表全局唯一且确定，字段 id 因此跨次生成相同 → records.fields 的 JSON key 逐字节一致；
//   - 时间戳一律 BASE_MS + 确定性偏移。

/** mulberry32：32 位确定性 PRNG，返回 [0,1) float。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** [0,1) */
  float(): number {
    return this.next();
  }

  /** [min,max] 闭区间整数。 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 以概率 p（0..1）为真。 */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** 等概率取一个元素。 */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  /**
   * 80/20 偏态下标：返回 0..n-1 中的一个，少量（约 20%）桶承载约 80% 选择。
   * 用幂分布 idx=floor(n * u^4)（u∈[0,1)），指数越大越偏，4 近似 Pareto 80/20。
   */
  skewedIndex(n: number, skewExp = 4): number {
    if (n <= 1) return 0;
    return Math.min(n - 1, Math.floor(n * Math.pow(this.next(), skewExp)));
  }

  /** 从 arr 中取 k 个【不重复】元素（k>=arr.length 时返回打乱的全部）。 */
  sample<T>(arr: readonly T[], k: number): T[] {
    const pool = [...arr];
    // Fisher–Yates 部分洗牌（确定性，用本 RNG）。
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, Math.min(k, pool.length));
  }
}

// ---- 全局确定性 id 序列 ----
let seq = 0;

/** 每个生成任务开头重置（与 --seed 配合保证同序列）。 */
export function resetIds(start = 1): void {
  seq = start - 1;
}

/**
 * 确定性全局 id：语义前缀 + 定长 base36 自增序号。跨表全局唯一（同一计数器），
 * 形如 "fld_0000000000ab"。应用与索引不校验 id 格式，只要求唯一/可复现。
 */
export function seqId(prefix: string, pad = 16): string {
  seq += 1;
  return `${prefix}${seq.toString(36).padStart(pad, "0")}`;
}

/** 当前序列值（生成报告对账实体总数）。 */
export function currentSeq(): number {
  return seq;
}

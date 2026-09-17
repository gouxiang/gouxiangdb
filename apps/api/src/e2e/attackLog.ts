// M6/S8 对抗台账：「输入 → 期望码 → 实际码」三列留证。
//
// 动机（派工单纪律）：「对抗必须是真攻击」——每条先构造应被拒的输入，断言**拒绝码**；
// 不许把 happy path 当对抗、不许用"能跑通"冒充"能拦住"。台账把这条纪律变成可粘贴进
// baseline / 报告的结构化记录（并在 afterAll 打印成表，供出口复核者逐行核对）。

export type EntryPoint = "http" | "stdio";

export interface AttackRow {
  /** 对抗编号（AC-M6-1 / IDOR-canvas-read / …）。 */
  id: string;
  entry: EntryPoint;
  /** 构造的恶意/越权输入（人可读，不含 token 与业务值）。 */
  input: string;
  /** 期望拒绝码（§317 词汇或协议码）。 */
  expected: string;
  /** 实际观测码。 */
  actual: string;
  verdict: "PASS" | "FAIL";
  note?: string;
}

const rows: AttackRow[] = [];

export function recordAttack(row: AttackRow): void {
  rows.push(row);
}

export function attackRows(): readonly AttackRow[] {
  return rows;
}

/** 打印 Markdown 表（e2e 日志可整段粘进 baseline）。 */
export function dumpAttackMatrix(): void {
  const head = "| 编号 | 入口 | 输入 | 期望码 | 实际码 | 判定 |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => `| ${r.id} | ${r.entry} | ${r.input} | ${r.expected} | ${r.actual} | ${r.verdict} |`);
  console.info(`\n[M6-S8 对抗矩阵]\n${head}\n${sep}\n${body.join("\n")}\n`);
}

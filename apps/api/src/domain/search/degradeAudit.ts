// M5/S12 检索降级跳变采样审计（§4.9 / §9 search_degraded）。
//
// 只在降级【状态发生跳变】时经 writeAudit 打一条 search_degraded：
//   - 非降级（reason 集合为空）-> 出现降级：打一条（含 reason 集合/mode/recovering）；
//   - 同态重复搜索（reason 集合相同）：不重复打；
//   - reason 集合变化（如 vec_unavailable -> embedding_unhealthy）：视为新态，打一条；
//   - 恢复正常（reason 清空）后再次降级：可再打一条。
//
// 脱敏铁律：detail 只许技术态（reason 集合 / mode / 是否 recovering），
// 绝不落查询词、标题、字段值、key、向量、实体 id。writeAudit 自身的 SENSITIVE_PARTS 是第二道网。

/** 技术态签名：reason 集合（排序去重）+ mode + recovering，同态不重复打点。 */
interface DegradeState {
  /** 当次实际执行 mode（hybrid|vector|fts|like）。 */
  mode: string;
  /** 当次降级原因集合（空数组=完全健康）。 */
  reasons: readonly string[];
  /** 是否处于 search.db 损坏恢复应急态。 */
  recovering: boolean;
}

/** 进程内上一次技术态；null=尚未观测（首次健康不打点，首次降级才打）。 */
let lastSignature: string | null = null;

/** 仅供测试复位：清空进程内记忆态。 */
export function resetDegradeAuditState(): void {
  lastSignature = null;
}

/** 生成技术态签名（reason 排序去重 + mode + recovering）。不含任何业务值。 */
export function degradeSignature(s: DegradeState): string {
  const reasons = [...new Set(s.reasons)].sort().join(",");
  return `${s.mode}|${s.recovering ? 1 : 0}|${reasons}`;
}

/**
 * 观测一次检索的降级态；仅在跳变时返回应写入的审计 detail（调用方据此 writeAudit）。
 * 返回 null=同态/首启健康，不打点。纯状态机：不直接 IO，便于单测。
 */
export function observeDegrade(s: DegradeState): { event: "search_degraded"; detail: Record<string, unknown> } | null {
  const reasons = [...new Set(s.reasons)].sort();
  const degraded = reasons.length > 0 || s.recovering;
  const sig = degradeSignature(s);

  // 完全健康：只更新记忆，不打点（恢复本身不是故障事件）。
  if (!degraded) {
    lastSignature = sig;
    return null;
  }
  // 同态重复：不刷第二行。
  if (sig === lastSignature) return null;

  lastSignature = sig;
  return {
    event: "search_degraded",
    detail: {
      reasons,
      mode: s.mode,
      recovering: s.recovering,
    },
  };
}

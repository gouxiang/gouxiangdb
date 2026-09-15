// apps/api/src/configAuthz.ts
// M4 权限引擎模式（GX_AUTHZ_ENGINE）解析与阶段门——从 config.ts 抽出的纯函数（node 内置依赖，
// 无 db/Hono），供 config 启动接线、guards/kb 守卫运行时 per-call 读取、index 启动日志共用。
//
//   off（默认，含未设置/未知值/空值）= 七守完全走旧三表决策，shadow 适配层零新增 SQL；
//   shadow = 旧决策为准并照常返回，额外 await 引擎同上下文对拍，差异只分类计数/记脱敏日志，不改响应；
//   on     = 以引擎决策为准。
// 代码默认恒 off（与 M1 各 flag 保守默认一致）；生产建议值由部署侧显式设 shadow。

export type AuthzEngineMode = "off" | "shadow" | "on";

/**
 * 阶段门（M4 计划 §7-S3 行559 定稿）：S3-S5 期间引擎能力未齐（策略双写/fieldMask 五出口
 * 下推在 S5/S6），此刻 on 只判节点动作会误拒，故 on 一律解析为 shadow 并打一次 warn；
 * S6 完成、§4.8 翻门五条件全满足且仅由项目总监下令后才置 true，on 方真正生效。
 */
export const AUTHZ_ENFORCE_READY = false;

let onDowngradeWarned = false;

/** 纯函数：env -> 配置的原始模式（不做阶段降级），未知/缺省保守回 off。 */
export function resolveAuthzEngineMode(env: NodeJS.ProcessEnv = process.env): AuthzEngineMode {
  const v = (env.GX_AUTHZ_ENGINE ?? "off").trim().toLowerCase();
  if (v === "shadow" || v === "on") return v;
  return "off";
}

/**
 * 生效模式：经阶段门收敛。S3-S5（AUTHZ_ENFORCE_READY=false）时 on 降级 shadow 并 warn 一次；
 * 守卫运行时按本结果分支，保证误开 on 也不会提前以引擎为准造成误拒。
 */
export function effectiveAuthzMode(env: NodeJS.ProcessEnv = process.env): AuthzEngineMode {
  const mode = resolveAuthzEngineMode(env);
  if (mode === "on" && !AUTHZ_ENFORCE_READY) {
    if (!onDowngradeWarned) {
      console.warn(
        "[authz] GX_AUTHZ_ENGINE=on 在当前阶段（S3-S5，强制能力未齐）降级为 shadow："
          + "旧决策仍为准，引擎仅对拍不生效；S6 完成且翻门后 on 才生效。",
      );
      onDowngradeWarned = true;
    }
    return "shadow";
  }
  return mode;
}

/** 是否处于 shadow 对拍（off 时为 false，守卫据此短路，零新增 SQL/不实例化引擎）。 */
export function authzShadowActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return effectiveAuthzMode(env) === "shadow";
}

/**
 * 字段掩码五出口（M4-S6）独立就绪门（计划 §7-S6 行622）。
 *
 * 与节点守卫全局 enforce（AUTHZ_ENFORCE_READY，S10 才翻）刻意分离：
 *   - 本门读【原始】GX_AUTHZ_ENGINE（resolveAuthzEngineMode，不经 on->shadow 降级），
 *     故 GX_AUTHZ_ENGINE=on 时，即便七守 r/u 仍按全局门降级 shadow，fieldMask 的
 *     读投影/写键校验/物理下推屏蔽已按 on 生效，使 A-4/AC-M4-3 在 S6 可独立验收；
 *   - off/shadow 恒 false：五出口全部短路，不实例化掩码解析、零新增 SQL，
 *     响应与 M3/M4-S0 金标准逐字节一致。
 * 边界安全（S7 tree/menu 剪枝缺失下不产生节点级越权/误拒）：S6 的 enforce 只在
 * "表级 r 已由旧守卫成立"之后做字段维收窄（只减不增），表级可达性判定留 S7/S10。
 */
export const FIELD_MASK_ENFORCE_READY = true;

/** 字段掩码五出口是否生效：仅 S6 就绪且原始模式为 on 时为真。 */
export function fieldMaskEnforceEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  return FIELD_MASK_ENFORCE_READY && resolveAuthzEngineMode(env) === "on";
}

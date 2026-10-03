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

/**
 * tree/menu 服务端剪枝 + 面包屑中性截断（M4-S7，裁决 A-6）独立就绪门。
 *
 * 与 FIELD_MASK 门同构、与 S10 才翻的节点守卫全局门（AUTHZ_ENFORCE_READY）刻意分离：
 *   - 读【原始】GX_AUTHZ_ENGINE（不经 on->shadow 降级），on 时 readNavTree/readMenuTree/
 *     breadcrumb 按引擎可见集剪枝，而七守 r/u 仍 shadow（旧决策为准放行），
 *     使"父无权子 direct 有权三通道/无越权泄漏"在 S7 可独立验收；
 *   - off/shadow 恒 false：树与菜单短路全量返回，零引擎 SQL，响应与 M3 金标准逐字节一致；
 *   - 只减不增：剪枝只从全量集合删节点，从不放行任何被旧守卫拒绝的请求（shortcut/URL
 *     能否打开仍由旧守卫/内容端点决定），故全局 enforce 未翻也安全。
 *
 * ★ 上面这条「故全局 enforce 未翻也安全」的安全论证【已被证伪，勿再据此放心】。
 *   它成立的前提是「剪掉的正是本不该看的节点」，而通电前体检 [4] 段实测（dev.db 字节副本，
 *   已完成存量全量投影）：库节点抽样 24 个、可见 **0** 个——被剪掉的是二代 `visible=true`
 *   判定「该看」的库，删错了。"只减不增"只剩字面成立（确实没放行任何东西），但没防住删错。
 *   连带后果比"点不进库"更深一层：`nav/prune.ts` 的 resourceAncestorsPass 沿 parentId 向上，
 *   **任一资源祖先不在 visible 集即拒**，故库被剪 ⇒ 库内表/视图一并从导航消失。
 *   触发条件（注意是现存可触发态，不是未来态）：本门读原始 env，故 **GX_AUTHZ_ENGINE=on 即生效，
 *   与 AUTHZ_ENFORCE_READY 无关**——env=on 而总门未翻时，剪枝已按 on 生效、七守仍 shadow。
 *   修法不在本文件（改门只会把头埋沙里），见 docs/runbooks/authz-engine-flip-on.md §1.5 风险段。
 */
export const NAV_PRUNE_ENFORCE_READY = true;

/** tree/menu 剪枝是否生效：仅 S7 就绪且原始模式为 on 时为真。 */
export function navPruneEnforceEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  return NAV_PRUNE_ENFORCE_READY && resolveAuthzEngineMode(env) === "on";
}

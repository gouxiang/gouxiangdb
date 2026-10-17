// apps/web/src/node/shellBridge.ts
// 成品 Mac 壳桥（IMPL-0.2.5-beta.md §3 冻结命令契约）：WebView 经 Tauri v2 全局命令通道
// `window.__TAURI_INTERNALS__.invoke` 调用 Rust 侧 7 条 gx:* 命令。
//
// 铁律（§2/§3）：
//   - **零 npm 依赖**：不 import @tauri-apps/api（withGlobalTauri=true 已把通道挂到 window）；
//   - **import 无副作用**：本模块只做类型声明与薄封装，不在顶层读 window / 不注册任何东西；
//   - **fail-closed**：浏览器 / fnOS / 服务器构建没有 __TAURI_INTERNALS__，hasShell()=false，
//     任何 invokeGx 调用直接抛中文错误「不在桌面壳环境」（仅门控开启且在壳内才会触达）。
//
// 命令错误统一由 Rust 侧以 {ok:false,error} 或 reject 返回，中文 error 可直接展示；本层不吞错。

/** Tauri v2 全局命令通道的最小结构（withGlobalTauri=true 时由壳注入）。 */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

// ── §3 冻结的命令名（单一真源，禁止漂移）─────────────────────────────────────────

export const CMD = {
  getShellInfo: "gx:get_shell_info",
  localStatus: "gx:local_status",
  startLocal: "gx:start_local",
  stopLocal: "gx:stop_local",
  setActiveUpstream: "gx:set_active_upstream",
  beginProbe: "gx:begin_probe",
  endProbe: "gx:end_probe",
} as const;

// ── §3 返回/入参类型（与 Rust 侧签名逐字段对齐）──────────────────────────────────

/** gx:get_shell_info：web 据此判定「在成品壳内」。 */
export interface ShellInfo {
  shellVersion: string;
  platform: string;
  arch: string;
  shellPort: number;
  launcher: boolean;
}

/** gx:local_status：added=曾添加；running=进程在；ready=/readyz 绿。 */
export interface LocalStatus {
  added: boolean;
  initialized: boolean;
  running: boolean;
  ready: boolean;
  kernelPort: number | null;
}

/** gx:start_local：成功带回内核端口与是否已初始化；失败带中文 error。 */
export type StartLocalResult =
  | { ok: true; kernelPort: number; initialized: boolean }
  | { ok: false; error: string };

/** gx:set_active_upstream 入参。 */
export interface ActiveUpstreamArg {
  kind: "local" | "remote" | "none";
  /** remote 时为规范化 http(s) baseURL；local/none 不带。 */
  target?: string;
}

/** gx:begin_probe 入参 / 返回。 */
export interface BeginProbeArg {
  baseURL: string;
}
export interface BeginProbeResult {
  probeId: string;
}

/** gx:end_probe 入参 / 返回（注销幂等，ok 表达是否曾命中）。 */
export interface EndProbeArg {
  probeId: string;
}
export interface EndProbeResult {
  ok: boolean;
}

/** 仅返回 {ok:true} 的命令（stop_local / set_active_upstream）。 */
export interface OkResult {
  ok: true;
}

// ── 测试替身 seam（不引入依赖、不污染生产路径；生产永不调用）──────────────────────

let invokeOverride: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null =
  null;
let shellPresentOverride: boolean | null = null;

/** 仅供单测：注入假 invoke 通道与壳存在态；测完务必 __resetShellBridgeForTest。 */
export function __setShellBridgeForTest(seam: {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  shellPresent?: boolean;
}): void {
  invokeOverride = seam.invoke;
  shellPresentOverride = seam.shellPresent === undefined ? true : seam.shellPresent;
}

/** 仅供单测：恢复默认（读真实 window.__TAURI_INTERNALS__）。 */
export function __resetShellBridgeForTest(): void {
  invokeOverride = null;
  shellPresentOverride = null;
}

// ── 通道检测与薄封装 ────────────────────────────────────────────────────────────

/**
 * 是否运行在成品桌面壳内：全局 Tauri v2 命令通道存在且 invoke 是函数。
 * SSR/非浏览器环境恒为 false。
 */
export function hasShell(): boolean {
  if (shellPresentOverride !== null) return shellPresentOverride;
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

/**
 * 薄封装全局 invoke。非壳环境调用直接抛中文错误（fail-closed），不返回 reject 之外的兜底。
 * 成功时把 Rust 返回值断言为调用方声明的类型；命令自身的业务错误由 Rust reject 或 {ok:false} 表达。
 */
export function invokeGx<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (invokeOverride) {
    return invokeOverride(cmd, args) as Promise<T>;
  }
  if (
    typeof window === "undefined" ||
    typeof window.__TAURI_INTERNALS__?.invoke !== "function"
  ) {
    return Promise.reject(new Error("不在桌面壳环境"));
  }
  return window.__TAURI_INTERNALS__.invoke(cmd, args) as Promise<T>;
}

// ── §3 七条命令的类型化包装（入参/返回严格按契约表）──────────────────────────────

/** gx:get_shell_info（无入参）。 */
export function getShellInfo(): Promise<ShellInfo> {
  return invokeGx<ShellInfo>(CMD.getShellInfo);
}

/** gx:local_status（无入参）。 */
export function localStatus(): Promise<LocalStatus> {
  return invokeGx<LocalStatus>(CMD.localStatus);
}

/**
 * gx:start_local。Rust 以 {ok:false,error} 表达可展示的启动失败（非 reject），
 * 故这里不抛错、原样返回联合结果，由编排层按 ok 分支收口为中文提示。
 */
export function startLocal(): Promise<StartLocalResult> {
  return invokeGx<StartLocalResult>(CMD.startLocal);
}

/** gx:stop_local（无入参，优雅停进程、不删数据）。 */
export function stopLocal(): Promise<OkResult> {
  return invokeGx<OkResult>(CMD.stopLocal);
}

/** gx:set_active_upstream（原子替换壳内 Mutex<Upstream>）。 */
export function setActiveUpstream(arg: ActiveUpstreamArg): Promise<OkResult> {
  return invokeGx<OkResult>(CMD.setActiveUpstream, { ...arg });
}

/** gx:begin_probe：注册短期 probeId→baseURL（TTL≤120s），不改变当前活动上游。 */
export function beginProbe(baseURL: string): Promise<BeginProbeResult> {
  return invokeGx<BeginProbeResult>(CMD.beginProbe, { baseURL });
}

/** gx:end_probe：立即注销 probeId（幂等）。 */
export function endProbe(probeId: string): Promise<EndProbeResult> {
  return invokeGx<EndProbeResult>(CMD.endProbe, { probeId });
}

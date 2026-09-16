// M5/S2 vec0 原生扩展解析与加载（唯一原生素）。
//
// 权威依据：M5-implementation-plan §0.2 H1/H6/H7/H8、§12 原生供应链。
//   H1 better-sqlite3@13 内建 SQLite 3.53，直接 db.loadExtension()，无 enable 开关；
//   H6 sqlite-vec 按 os/cpu 拆 5 个 optionalDependencies 子包，仅 glibc（无 musl/Alpine、无 32 位）；
//   H7 入口符号按【文件名】推导——产物文件名恒 vec0.<ext>，按 triplet 分目录而非改名，
//      改名 vec0.so 会 dlsym symbol not found；
//   H8 加载失败必须是可捕获异常，不 crash 主进程：调用方据 vecAvailable 降级 fts-only。
//
// 解析顺序（全部不抛到主流程，失败由 loadVec0 捕获）：
//   1. 显式 GX_VEC_EXT_PATH（运维覆盖；要求文件名恒 vec0.<ext>，仅信任目录/路径不改名）；
//   2. 发布包白名单拷贝目录 <appDir>/native/<triplet>/vec0.<ext>（打包脚本 copy-vec-native.mjs）；
//   3. node_modules 内 sqlite-vec 的 getLoadablePath()（require.resolve 平台子包）。
// 本文件不读 search.db、不做任何 IO 之外的副作用；纯解析函数单独导出供表驱动单测。

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 入口文件名恒为 vec0（H7）；扩展名随平台。 */
export const VEC_ENTRY_BASENAME = "vec0";

export type VecTriplet =
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "win32-x64";

export interface VecPlatform {
  /** 发布包子目录名 native/<triplet>。 */
  triplet: VecTriplet;
  /** 动态库扩展名（不含点）。 */
  ext: "dylib" | "so" | "dll";
  /** 对应 sqlite-vec 平台子包名。 */
  subPackage: string;
  /** 是否受支持：false 表示该 os/cpu 无预编译（如 linux musl/32 位由调用方另判 libc）。 */
  supported: boolean;
}

/**
 * 把 process.platform/arch 映射为 vec0 平台描述。
 * 不支持的平台（win32-arm64、linux-ia32 等）返回 supported=false——加载侧据此直接降级，
 * 绝不尝试 dlopen 一个不存在的库。
 */
export function describeVecPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): VecPlatform {
  const ext: VecPlatform["ext"] = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
  const osName = platform === "win32" ? "windows" : platform;
  const triplet = `${platform}-${arch}` as VecTriplet;
  const supported =
    (platform === "darwin" && (arch === "x64" || arch === "arm64"))
    || (platform === "linux" && (arch === "x64" || arch === "arm64"))
    || (platform === "win32" && arch === "x64");
  return { triplet, ext, subPackage: `sqlite-vec-${osName}-${arch}`, supported };
}

/** native/<triplet>/vec0.<ext> 白名单拷贝路径（存在才用）。 */
export function bundledVecPath(appDir: string, platformInfo: VecPlatform = describeVecPlatform()): string {
  return path.join(appDir, "native", platformInfo.triplet, `${VEC_ENTRY_BASENAME}.${platformInfo.ext}`);
}

/**
 * 从 node_modules 解析平台子包内 vec0。
 *
 * 关键：sqlite-vec 按 pnpm/npm 布局把平台子包（sqlite-vec-<os>-<arch>）放在【主包自己的】
 * node_modules 下并经 require.resolve(相对主包 cjs) 定位；从本模块位置直接 resolve
 * `sqlite-vec-linux-x64/vec0.so` 在 pnpm 严格布局下会 MODULE_NOT_FOUND。因此委托主包自带的
 * getLoadablePath()（其内部按 process.platform/arch 解析）。sqlite-vec 是 optionalDependency，
 * require 失败（平台子包缺失/未安装）必须可吞 -> 返回 null，由加载侧降级。
 */
function defaultPackageVecPath(): string | null {
  try {
    const mod = require("sqlite-vec") as { getLoadablePath?: () => string };
    return typeof mod.getLoadablePath === "function" ? mod.getLoadablePath() : null;
  } catch {
    return null;
  }
}

/**
 * 解析 vec0 可加载文件绝对路径。返回 null 表示三类候选都不可用（调用方据此降级，不抛）。
 *
 * @param envPath        GX_VEC_EXT_PATH 显式覆盖（允许指向 vec0.<ext> 或其所在目录）。
 * @param appDir         发布包应用目录（dist 上一级）。
 * @param platformInfo   平台描述（测试可注入）。
 * @param fileExists     路径存在判定（测试可注入虚拟 fs）。
 * @param resolvePackage node_modules 回退解析（默认委托 sqlite-vec.getLoadablePath）。
 */
export function resolveVecPath(
  envPath: string | undefined,
  appDir: string,
  platformInfo: VecPlatform = describeVecPlatform(),
  fileExists: (p: string) => boolean = (p) => fs.existsSync(p),
  resolvePackage: () => string | null = defaultPackageVecPath,
): string | null {
  if (!platformInfo.supported) return null;
  const fileName = `${VEC_ENTRY_BASENAME}.${platformInfo.ext}`;

  // 1) 显式覆盖：给文件直接用；给目录则拼恒名文件。不据覆盖值改名（H7）。
  const env = envPath?.trim();
  if (env) {
    const direct = path.isAbsolute(env) ? env : path.resolve(appDir, env);
    if (fileExists(direct)) return direct;
    const inDir = path.join(direct, fileName);
    if (fileExists(inDir)) return inDir;
  }

  // 2) 发布包白名单 native/<triplet>/vec0.<ext>。
  const bundled = bundledVecPath(appDir, platformInfo);
  if (fileExists(bundled)) return bundled;

  // 3) node_modules 平台子包（开发态 / 未走白名单拷贝的部署态）。
  const fromPackage = resolvePackage();
  if (fromPackage && fileExists(fromPackage)) return fromPackage;

  return null;
}

export interface VecLoadResult {
  /** vec0 是否加载成功；false 时主流程必须降级 fts-only（H8）。 */
  vecAvailable: boolean;
  /** 实际加载的文件绝对路径；失败为 null。 */
  path: string | null;
  /** 失败原因（仅用于日志/status，不向主流程抛）；成功为 null。 */
  error: string | null;
}

/** 已打开的 better-sqlite3 连接所需最小形状（避免本文件硬依赖具体实例类型）。 */
export interface VecLoadableDb {
  loadExtension(file: string): void;
}

/**
 * 在给定连接上加载 vec0。任何失败（路径缺失/平台不支持/dlopen 失败/改名 dlsym 失败）
 * 都被捕获为 { vecAvailable:false }，绝不抛出——满足 H8「加载失败可捕获、不 crash」。
 */
export function loadVec0(
  db: VecLoadableDb,
  opts: {
    envPath?: string;
    appDir: string;
    platformInfo?: VecPlatform;
    /** 测试注入：模拟 sqlite-vec 可选依赖未安装（musl 等），默认走真实包解析。 */
    resolvePackage?: () => string | null;
  },
): VecLoadResult {
  const info = opts.platformInfo ?? describeVecPlatform();
  const resolved = resolveVecPath(opts.envPath, opts.appDir, info, undefined, opts.resolvePackage);
  if (!resolved) {
    return {
      vecAvailable: false,
      path: null,
      error: info.supported
        ? `vec0 not found (GX_VEC_EXT_PATH/native/${info.triplet}/node_modules all unavailable)`
        : `unsupported platform for vec0: ${info.triplet} (falling back to fts-only)`,
    };
  }
  try {
    db.loadExtension(resolved);
    return { vecAvailable: true, path: resolved, error: null };
  } catch (err) {
    return { vecAvailable: false, path: resolved, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

/**
 * 已加载 vec0 的连接上读取 vec_version()；读不到返回 null（不抛）。
 * 供启动日志/status 与发版冒烟使用。
 */
export function readVecVersion(db: VecLoadableDb & { prepare: (sql: string) => { get: () => unknown } }): string | null {
  try {
    const row = db.prepare("select vec_version() as v").get() as { v: string } | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// BigInt / Float32-BLOB 绑定 helper（§4.2 绑定铁律 H2/H3）
// ---------------------------------------------------------------------------

/**
 * vec0 rowid / INTEGER 元数据列绑定：统一转 bigint。
 * bsc13 把普通 number 绑成 REAL，vec0 对 rowid/INTEGER 元数据收到 REAL 会整事务拒绝
 * （"Only integers..." / "received FLOAT"，H2）。这里把安全整数收敛为 bigint；
 * 非安全整数/非数值直接抛 TypeError（调用点单测钉死），宁可早失败也不发 REAL。
 */
export function vecInt(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`vec0 integer binding requires a safe integer or bigint, got: ${String(value)}`);
}

/**
 * 向量绑定：Float32Array 的底层字节以小端 float32 BLOB 提交（H3）。
 * vec0 仅接受 Float32 BLOB，传 JSON 数组文本走不通；统一经此入口，禁内联 JSON。
 * 入参为普通 number[] 时按元素拷贝进 Float32Array（元素被确定性转成 float32）。
 */
export function vecBlob(vector: Float32Array | readonly number[]): Buffer {
  const ta = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  // slice() 复制底层 ArrayBuffer，避免外部 TA 是大 ArrayBuffer 的一个视图时把多余字节绑进去。
  return Buffer.from(ta.slice().buffer);
}

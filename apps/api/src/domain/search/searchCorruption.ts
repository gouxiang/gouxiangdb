// M5/S12 search.db 损坏分类与物理隔离（ADR-0049 / §4.9「search.db 损坏/打不开」）。
//
// 本文件只做两件无业务、无鉴权的纯 IO/分类工作：
//   1) 把 better-sqlite3 抛出的错误分类为「库损坏」（SQLITE_NOTADB / SQLITE_CORRUPT /
//      "database disk image is malformed" / "file is not a database"）；
//   2) 把损坏的主库连同 -wal/-shm 一起 rename 成 .corrupt-<ts> 隔离物（三件一起搬、绝不删除）。
//
// 边界：
//   - 「文件不存在」不算损坏——那是懒初始化正常建库场景，由 openSearchStore 直接建新库，
//     绝不能把"首启还没建库"误判成损坏而进入恢复/审计。
//   - 隔离只 rename 不 unlink：坏库是排障证据，且可能含尚未重播的派生数据；删除由运维按留存策略做。
//   - 调用方必须【先关闭持有该文件的连接】再调 quarantine（Windows/锁场景下 rename 才可靠）。

import fs from "node:fs";

/** openSearchStore 探测到现役库物理损坏时抛出；携带路径供恢复层隔离/重开。 */
export class SearchStoreCorruptError extends Error {
  readonly filePath: string;
  constructor(filePath: string, cause: unknown) {
    super(`search.db corrupt at ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SearchStoreCorruptError";
    this.filePath = filePath;
    if (cause instanceof Error) this.cause = cause;
  }
}

/** 明确表示库物理损坏的 SQLite 主错误码（better-sqlite3 挂 err.code 或 err.cause.code）。 */
const CORRUPT_CODES = new Set([
  "SQLITE_CORRUPT", // 11：database disk image is malformed
  "SQLITE_NOTADB", // 26：file is not a database（魔数错误/被截断成非库）
]);

/** 错误消息兜底匹配（中文系统信息/不同驱动包装下 code 可能缺失）。 */
const CORRUPT_MESSAGE
  = /(database disk image is malformed)|(file is encrypted or is not a database)|(file is not a database)|(disk image)|(malformed database schema)/i;

/**
 * 判断一个异常是否表示 search.db 物理损坏（而非普通查询错误/缺文件）。
 * 仅当错误码或消息命中损坏特征才返回 true；SQLITE_CANTOPEN（缺目录/权限）不在此列。
 */
export function isCorruptionError(err: unknown): boolean {
  if (!err) return false;
  // 本域翻译过的损坏错误（可能在调用链上被二次包装/再次捕获）。
  if (err instanceof SearchStoreCorruptError) return true;
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  if (e.name === "SearchStoreCorruptError") return true;
  const code = e.code ?? e.cause?.code;
  if (typeof code === "string" && CORRUPT_CODES.has(code)) return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return CORRUPT_MESSAGE.test(msg);
}

export interface QuarantineResult {
  /** 隔离时间戳（毫秒），三件共用同一后缀。 */
  ts: number;
  /** 主库隔离后的绝对路径 `<file>.corrupt-<ts>`。 */
  quarantinedPath: string;
  /** 实际被 rename 搬走的文件（主库必在；wal/shm 存在才在）。 */
  moved: string[];
}

/**
 * 把损坏库三件（主库/-wal/-shm）rename 为 `.corrupt-<ts>` 隔离物，绝不删除。
 *
 * 前置：调用方已关闭该库的全部连接。主库文件不存在时抛错（那是缺文件而非损坏，
 * 不应走本函数）；sidecar 缺失视为正常（WAL checkpoint 后可能本就没有）。
 * 同名隔离物已存在（同毫秒二次恢复）时追加序号，绝不覆盖既有证据。
 */
export function quarantineCorruptFiles(filePath: string, ts: number = Date.now()): QuarantineResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`quarantine 拒绝执行：主库文件不存在，不是损坏场景: ${filePath}`);
  }
  const base = `${filePath}.corrupt-${ts}`;
  const quarantinedPath = uniquePath(base);
  const moved: string[] = [];

  // 主库先搬；sidecar 用与主库相同的 <ts> 关联后缀，便于成组识别与清理。
  fs.renameSync(filePath, quarantinedPath);
  moved.push(quarantinedPath);

  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = `${filePath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      const dest = uniquePath(`${base}${suffix}`);
      fs.renameSync(sidecar, dest);
      moved.push(dest);
    }
  }
  return { ts, quarantinedPath, moved };
}

/** 目标路径已存在时追加 -2/-3…，保证不覆盖任何既有隔离证据。 */
function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${p}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`quarantine 无法取得唯一隔离路径: ${p}`);
}

// M5/S12 真实 search.db 损坏注入（非 .test.ts，不被收集）：复刻进程崩溃后的现场。
//
// 步骤：
//   1) 关单例，另开连接写一帧已提交 WAL；趁该连接仍打开把真实 -wal/-shm 字节复制为证据
//      （正常 close 会 checkpoint 并删掉 sidecar，所以必须先复制）；
//   2) 把主库改成非 SQLite 内容（魔数 / 截断），再把证据复制回 search.db-wal/-shm，
//      即崩溃遗留 sidecar。openSearchStore 读坏 header 立即 NOTADB，quarantine 三件一起搬。

import fs from "node:fs";
import path from "node:path";
import type * as SearchStore from "../../../domain/search/searchStore.js";

export interface DamageHelpers {
  /** 主库偏移 0 写 49 字节非 SQLite 魔数（NOTADB），残留 -wal/-shm 一并复刻。 */
  corruptMagic: () => void;
  /** 主库 ftruncate 到 4096 字节（SQLITE_CORRUPT malformed 的另一种真实形态）。 */
  truncate4096: () => void;
  /**
   * 无操作占位：损坏注入不持有连接（直接复刻崩溃三文件），触发自愈后调用仅为让演练步骤可读。
   */
  releaseHandle: () => void;
}

export function createDamageHelpers(deps: {
  searchStore: typeof SearchStore;
  searchPath: string;
  tmpDir: string;
}): DamageHelpers {
  const { searchStore, searchPath, tmpDir } = deps;

  const damageMain = (mutate: (fd: number) => void): void => {
    searchStore.closeSearchStore();
    const dirty = searchStore.openSearchStore({
      filePath: searchPath, appDir: process.cwd(), tryLoadVec: false,
    });
    dirty.writeTxn("s12-dirty-wal", (tx) => {
      tx.prepare(
        "INSERT INTO index_meta(k,v) VALUES ('s12.dirty','1') ON CONFLICT(k) DO UPDATE SET v='1'",
      ).run();
    });
    const stamp = Date.now();
    const savedWal = path.join(tmpDir, `.saved-${stamp}-wal`);
    const savedShm = path.join(tmpDir, `.saved-${stamp}-shm`);
    fs.copyFileSync(`${searchPath}-wal`, savedWal);
    fs.copyFileSync(`${searchPath}-shm`, savedShm);
    dirty.close(); // 正常 checkpoint、sidecar 被删；主库含脏帧内容
    const fd = fs.openSync(searchPath, "r+");
    try { mutate(fd); } finally { fs.closeSync(fd); }
    fs.copyFileSync(savedWal, `${searchPath}-wal`); // 崩溃遗留：真实 WAL 帧 + 坏主库
    fs.copyFileSync(savedShm, `${searchPath}-shm`);
    fs.rmSync(savedWal, { force: true });
    fs.rmSync(savedShm, { force: true });
  };

  return {
    corruptMagic: () => damageMain((fd) => fs.writeSync(
      fd, Buffer.from("This is definitely not a SQLite database file!!!!", "utf8"), 0, 49, 0,
    )),
    truncate4096: () => damageMain((fd) => fs.ftruncateSync(fd, 4096)),
    releaseHandle: () => undefined,
  };
}

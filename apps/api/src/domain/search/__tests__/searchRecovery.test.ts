// M5/S12 recoverCorruptSearchStore 进程级恢复锁编排真机演练（临时真文件 + 真 SearchStore）。
// 不接 HTTP：直接构造现役健康库 -> 物理损坏三件（含残留 -wal/-shm）-> 调恢复，断言：
//   - 存在的主库+sidecar 全部成组 rename（绝不删除）；
//   - 同路径重开为已自举 schema 的空库且成为进程单例；
//   - 并发调用共享同一次恢复（不二次隔离、不覆盖证据）；
//   - 恢复锁在落定后释放（连续两次损坏各自独立隔离）——回归 IIFE finally 同步清锁 bug。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recoverCorruptSearchStore,
  isRecovering,
  resetRecoveryLock,
  repopulateRecoveredStore,
} from "../searchRecovery.js";
import {
  getSearchStore,
  closeSearchStore,
  openSearchStore,
} from "../searchStore.js";
import { SearchStoreCorruptError } from "../searchCorruption.js";

let dir: string;
let filePath: string;
const appDir = process.cwd();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-s12-rec-"));
  filePath = path.join(dir, "search.db");
  resetRecoveryLock();
  // 健康现役库（off/fts-only，避免依赖 vec0 平台包）。
  const s = openSearchStore({ filePath, appDir, tryLoadVec: false });
  s.writeTxn("seed", (tx) => {
    tx.exec("CREATE TABLE IF NOT EXISTS probe(k TEXT PRIMARY KEY, v TEXT)");
    tx.prepare("INSERT INTO probe(k,v) VALUES ('k1','v1')").run();
  });
  s.close();
});

afterEach(() => {
  closeSearchStore();
  resetRecoveryLock();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 主库写魔数 + 放一对残留 sidecar（模拟崩溃现场；不经 SQLite 打开故不会被其热恢复删除）。 */
function damageThreeFiles(): void {
  fs.writeFileSync(filePath, Buffer.from("This is definitely not a SQLite database file!!!!"));
  fs.writeFileSync(`${filePath}-wal`, Buffer.from("stale-wal-frame-bytes"));
  fs.writeFileSync(`${filePath}-shm`, Buffer.from("stale-shm-index-bytes"));
}

describe("recoverCorruptSearchStore 隔离+重开", () => {
  it("三件成组 rename 不删除；同路径重开为 schema 自举的空库并成为单例", async () => {
    damageThreeFiles();
    const r = await recoverCorruptSearchStore(filePath, { appDir, tryLoadVec: false });
    expect(r.moved).toHaveLength(3);
    expect(fs.existsSync(filePath)).toBe(true);
    // 证据保留且内容未被删改。
    expect(fs.readFileSync(r.quarantinedPath, "utf8").startsWith("This is definitely")).toBe(true);
    const wal = r.moved.find((f) => f.endsWith("-wal"))!;
    const shm = r.moved.find((f) => f.endsWith("-shm"))!;
    expect(fs.readFileSync(wal, "utf8")).toBe("stale-wal-frame-bytes");
    expect(fs.readFileSync(shm, "utf8")).toBe("stale-shm-index-bytes");
    // 新库可能自带全新 -wal/-shm（WAL 模式正常现象），但绝不含旧坏帧字节。
    if (fs.existsSync(`${filePath}-wal`)) {
      expect(fs.readFileSync(`${filePath}-wal`, "utf8")).not.toContain("stale-wal-frame-bytes");
    }

    // 新空库：基础 schema 在（chunks 表可查、0 行），旧业务表 probe 不存在。
    const singleton = getSearchStore({ filePath, appDir, tryLoadVec: false });
    expect(singleton.filePath).toBe(filePath);
    expect((singleton.db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c).toBe(0);
    expect(singleton.db.prepare("SELECT name FROM sqlite_master WHERE name='probe'").get()).toBeUndefined();
    expect(isRecovering()).toBe(false);
  });

  it("仅主库（无 sidecar）也恢复，moved=1", async () => {
    fs.writeFileSync(filePath, Buffer.from("not-a-db"));
    const r = await recoverCorruptSearchStore(filePath, { appDir, tryLoadVec: false });
    expect(r.moved).toEqual([r.quarantinedPath]);
    expect((getSearchStore({ filePath, appDir, tryLoadVec: false }).db
      .prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c).toBe(0);
  });

  it("并发调用共享同一次恢复：只产生一组隔离物，不二次隔离新库", async () => {
    damageThreeFiles();
    const [a, b] = await Promise.all([
      recoverCorruptSearchStore(filePath, { appDir, tryLoadVec: false }),
      recoverCorruptSearchStore(filePath, { appDir, tryLoadVec: false }),
    ]);
    expect(a.quarantinedPath).toBe(b.quarantinedPath);
    const groups = fs.readdirSync(dir).filter((f) => /\.corrupt-\d+$/.test(f));
    expect(groups).toHaveLength(1);
  });

  it("连续两次损坏：第二次独立隔离（回归恢复锁被同步 finally 永久卡住的 bug）", async () => {
    damageThreeFiles();
    await recoverCorruptSearchStore(filePath, { appDir, tryLoadVec: false });
    expect(isRecovering()).toBe(false);

    // 再次损坏现役（这次只改主库魔数）。
    closeSearchStore();
    fs.writeFileSync(filePath, Buffer.from("second corruption, also not a database"));
    const r2 = await recoverCorruptSearchStore(filePath, { appDir, tryLoadVec: false });
    const mains = fs.readdirSync(dir).filter((f) => /\.corrupt-\d+$/.test(f));
    expect(mains).toHaveLength(2);
    expect(fs.readFileSync(r2.quarantinedPath, "utf8").startsWith("second corruption")).toBe(true);
  });

  it("对损坏文件直接 openSearchStore 抛 SearchStoreCorruptError（恢复前的检测点）", () => {
    damageThreeFiles();
    closeSearchStore();
    expect(() => openSearchStore({ filePath, appDir, tryLoadVec: false })).toThrow(SearchStoreCorruptError);
  });
});

describe("repopulateRecoveredStore 失败不抛", () => {
  it("主库缺失/装配异常时返回零摘要而非抛出（可再手动 reindex）", async () => {
    const out = await repopulateRecoveredStore({
      prisma: {} as never, env: {}, dataDir: dir, appDir, jwtSecret: "x", searchPath: filePath,
    });
    expect(out).toEqual({ entities: 0, chunksWritten: 0, vecWritten: 0, vecDebt: 0 });
  });
});

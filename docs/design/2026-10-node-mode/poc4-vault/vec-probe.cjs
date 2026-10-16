// PoC-4 组1 项2：在【已挂载的加密 sparsebundle】内，用项目同款 better-sqlite3 建库、
// 加载 darwin-arm64 vec0、建普通表做增删改 + vec0 虚表跑一次 KNN。
//
// 目的：证伪/证实「加密磁盘匣路线 A 对数据访问内核（Prisma 引擎 / better-sqlite3 / sqlite-vec）
// 零侵入」——内核只看到挂载点里的普通文件，不应感知也不应受加密影响。
//
// 隔离工程（DESIGN-OFFLINE-SYNC §18.5「不动主仓产品代码」）：本脚本只读主仓 node_modules 里
// 已安装的运行时，库文件一律写到命令行传入的挂载点（沙箱 /tmp 下），绝不写主仓或真实数据目录。
//
// 用法：node vec-probe.cjs <挂载点目录> [vec0.dylib 路径]
// 退出码：0 全部断言通过；非 0 表示路线 A 在该内核组合上受阻（闸门不通过）。

const Database = require("better-sqlite3");

const mountDir = process.argv[2];
if (!mountDir) {
  console.error("usage: node vec-probe.cjs <mounted-vault-dir> [vec0-dylib]");
  process.exit(2);
}
// 默认解析主仓已装的 sqlite-vec darwin-arm64 件；可用第二参数覆盖（其它架构/路径）。
const vecPath =
  process.argv[3] ||
  require("node:path").resolve(
    __dirname,
    "../../../../node_modules/.pnpm/sqlite-vec-darwin-arm64@0.1.9/node_modules/sqlite-vec-darwin-arm64/vec0.dylib",
  );

const dbFile = require("node:path").join(mountDir, "sidecar.db");
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");

// ① vec0 loadExtension 成功（与项目 SearchStore/vecLoader 同一 db.loadExtension 姿势）。
db.loadExtension(vecPath);
const { v } = db.prepare("SELECT vec_version() AS v").get();
console.log("VEC_VERSION=", v);

db.exec("DROP TABLE IF EXISTS vec_chunks");
db.exec("DROP TABLE IF EXISTS t");

// ② 普通业务表增删改（代表 Prisma 引擎底下同一个 SQLite 文件的主读写）。
db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
const info = db.prepare("INSERT INTO t(name) VALUES(?)").run("hello-vault");
db.prepare("UPDATE t SET name=? WHERE id=?").run("hello-vault-updated", info.lastInsertRowid);
const row = db.prepare("SELECT * FROM t WHERE id=?").get(info.lastInsertRowid);
console.log("CRUD_ROW=", JSON.stringify(row));
if (row.name !== "hello-vault-updated") throw new Error("CRUD 回读不符");

// ③ vec0 虚表 + 向量写入 + KNN。注意 vec0 两条硬约束（项目 H2/H3）：
//    - rowid 必须绑整数 BLOB/INTEGER，better-sqlite3 用 BigInt，避免 JS number 被当 double；
//    - 向量载荷是小端 float32 BLOB（项目 vecLoader.vecBlob），不是 JSON 字符串。
db.exec("CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[4])");
const insVec = db.prepare("INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)");
const vecBlob = (x) => Buffer.from(Float32Array.from(x).buffer);
insVec.run(BigInt(1), vecBlob([1, 0, 0, 0]));
insVec.run(BigInt(2), vecBlob([0, 1, 0, 0]));
insVec.run(BigInt(3), vecBlob([0.9, 0.1, 0, 0]));
const knn = db
  .prepare("SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 2")
  .all(vecBlob([1, 0, 0, 0]));
console.log("KNN=", JSON.stringify(knn));
if (knn[0].rowid !== 1 || knn[1].rowid !== 3) throw new Error("KNN 排序不符，期望 [1,3]");

db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
console.log("POC4_VEC_OK", dbFile);

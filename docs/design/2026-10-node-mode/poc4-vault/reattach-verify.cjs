// PoC-4 组1 项3b：正确密码重挂后，读回业务表数据并再跑一次 vec KNN，确认跨 detach/attach
// 数据与向量索引完好。只读命令行传入的挂载点，不触碰真实数据目录。
//
// 用法：node reattach-verify.cjs <挂载点目录> [vec0.dylib 路径]
const Database = require("better-sqlite3");
const path = require("node:path");

const mountDir = process.argv[2];
if (!mountDir) {
  console.error("usage: node reattach-verify.cjs <mounted-vault-dir> [vec0-dylib]");
  process.exit(2);
}
const vecPath =
  process.argv[3] ||
  path.resolve(
    __dirname,
    "../../../../node_modules/.pnpm/sqlite-vec-darwin-arm64@0.1.9/node_modules/sqlite-vec-darwin-arm64/vec0.dylib",
  );

const db = new Database(path.join(mountDir, "sidecar.db"));
db.loadExtension(vecPath);
const r = db.prepare("SELECT name FROM t WHERE id=1").get();
const blob = (x) => Buffer.from(Float32Array.from(x).buffer);
const k = db
  .prepare("SELECT rowid FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
  .all(blob([0, 1, 0, 0]));
if (r.name !== "hello-vault-updated" || k[0].rowid !== 2) {
  throw new Error("重挂后数据/向量不符");
}
console.log("REATTACH_DATA_OK", JSON.stringify(r), "knnTop=" + k[0].rowid);
db.close();

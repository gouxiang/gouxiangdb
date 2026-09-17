// scripts/acceptance/blocks-roundtrip.mts
// 对 snapshot.json 内全部 doc 类型 kb_docs 的 content 跑 mdToBlocks -> blocksToMd，
// 产出 roundtrip.json：{items:[{docId, ok, normalized, error}]}。
//
// 口径（M7 §3.3）：升级【不改内容】，故 before/after 对同一 doc 的 normalized 必须逐字相等。
// normalized 是当前 @gx/blocks 转换后的规范化 md（允许转换本身对原始 md 有规范化损失，
// 但该损失在 before/after 必须一致——这正用于捕捉"升级过程动了正文"）。
//
// 用 tsx 运行（@gx/blocks 入口是 .ts 源码）：
//   pnpm --filter @gx/api exec tsx scripts/acceptance/blocks-roundtrip.mts --snapshot <dir>/snapshot.json --out <dir>/roundtrip.json
// 退出码：0 成功（含单个 doc 转换失败也照记 ok:false，由 diff 判失败）；64 参数错；1 快照读不了。

import fs from "node:fs";
import { mdToBlocks, blocksToMd } from "@gx/blocks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const snapshotPath = arg("--snapshot");
const outPath = arg("--out");
if (!snapshotPath || !outPath) {
  console.error("用法: blocks-roundtrip.mts --snapshot <snapshot.json> --out <roundtrip.json>");
  process.exit(64);
}

let snap: { legacy?: Record<string, { rows?: Array<Record<string, unknown>> }> };
try {
  snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
} catch (e) {
  console.error(`读不了快照：${(e as Error).message}`);
  process.exit(1);
}

const rows = snap.legacy?.kb_docs?.rows ?? [];
const items = rows
  .filter((r) => r.kind === "doc")
  .map((r) => {
    const docId = String(r.id);
    const content = typeof r.content === "string" ? r.content : "";
    try {
      const normalized = blocksToMd(mdToBlocks(content));
      return { docId, ok: true, normalized };
    } catch (e) {
      return { docId, ok: false, normalized: "", error: (e as Error).message };
    }
  });

fs.writeFileSync(outPath, JSON.stringify({ items }, null, 2));
const bad = items.filter((i) => !i.ok);
console.log(`[roundtrip] doc=${items.length}，转换失败=${bad.length} -> ${outPath}`);
if (bad.length) console.log(`[roundtrip] 失败 doc: ${bad.map((b) => b.docId).join(", ")}`);

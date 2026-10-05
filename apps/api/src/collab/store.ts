// apps/api/src/collab/store.ts
// collab_docs 旁路表的唯一读写出口（raw-only：schema.prisma 里【没有】对应 model）。
//
// 三条纪律：
//   1) 读走 prisma.$queryRawUnsafe —— PRAGMA/SELECT 这类要结果集的 raw 必须用 queryRaw，
//      executeRaw 不返回结果集（db.ts:88 的既有注释同为这一条）。
//   2) 写走 runWrite("collab.hot", ...)（db.ts:129）——协同不得自建第二个写队列，也不得
//      裸 prisma 写；回调内不得再调 runWrite/withWriteTx（队列并发度恒 1，会自死锁）。
//   3) state 直接绑 Uint8Array，不做 base64：Prisma raw × SQLite BLOB 已实测全等
//      （含 0x00/0xFF 边界，设计文档 §3.1）。读回来是 Buffer（Uint8Array 子类）。

import { prisma, runWrite } from "../db.js";
import type { CollabKind } from "@gx/shared-types";

interface CollabStateRow {
  /** null = 该房间还没有任何协同态（首次进入）。 */
  state: Uint8Array | null;
  /** 写入次数（单调递增，首次写入为 1）。 */
  seq: number;
  /** 房间上次落盘时的 kb_docs.contentVersion；table 房间为 null。 */
  baseVersion: number | null;
}

interface RawRow {
  state: Uint8Array | null;
  seq: number | null;
  base_version: number | null;
}

const SELECT_SQL = `SELECT "state", "seq", "base_version" FROM "collab_docs" WHERE "room_id" = ?`;

// ON CONFLICT 分支：state 直接覆盖、seq 自增、base_version 与 updated_at 取新值。
// 首次插入写 seq=1（而不是沿用列默认 0）：让「存在这一行」与「至少写过一次」等价，
// 排障与验收脚本看 seq>=1 即可判定落盘发生过，不必再数写入次数。
const UPSERT_SQL = `
INSERT INTO "collab_docs" ("room_id", "kind", "state", "seq", "base_version", "updated_at")
VALUES (?, ?, ?, 1, ?, ?)
ON CONFLICT("room_id") DO UPDATE SET
  "state" = excluded."state",
  "seq" = "collab_docs"."seq" + 1,
  "base_version" = excluded."base_version",
  "updated_at" = excluded."updated_at"
`;

/** 读一个房间的协同态；没有则 state=null（调用方据此决定要不要 applyUpdate）。 */
export async function loadCollabState(roomId: string): Promise<CollabStateRow> {
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(SELECT_SQL, roomId);
  const row = rows[0];
  if (!row) return { state: null, seq: 0, baseVersion: null };
  return {
    state: row.state ?? null,
    seq: Number(row.seq ?? 0),
    baseVersion: row.base_version === null || row.base_version === undefined ? null : Number(row.base_version),
  };
}

/**
 * 落盘一个房间的协同态（热路径唯一写点）。
 *
 * 只写 collab_docs 一行：不碰 kb_docs/records、不 bump updatedAt、不跑 nav 对账、
 * 不发搜索 outbox（DESIGN §2.3 两档写的热路径定义）。
 * 失败向调用方透传（协同 flush 失败不得静默，§3.7.4）。
 */
export async function saveCollabState(
  roomId: string,
  kind: CollabKind,
  state: Uint8Array,
  baseVersion: number | null,
): Promise<void> {
  const updatedAt = Date.now();
  await runWrite("collab.hot", () =>
    prisma.$executeRawUnsafe(UPSERT_SQL, roomId, kind, state, baseVersion, updatedAt),
  );
}

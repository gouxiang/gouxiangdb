// apps/api/src/collab/docFlush.ts
// 文档房间的冷归结（DESIGN §2.3 冷档 + §3.7 四条必做 + §3.2 冲突收口）。
//
// 归结路径只有一条：Y.Doc -> Block[] -> blocksToMd（@gx/blocks 唯一真源）
//   -> withWriteTx("collab.flush") 内的 saveDocContentTx（既有唯一写事务）。
// 因此自动快照 / 检索 outbox / nav 对账 / contentVersion+1 / updatedBy / updatedAt
// 全部照旧生效，版本历史与搜索索引不留空洞 —— 不开第二个同构写入口。
//
// 三条硬约束：
//   ① 无最后编辑者（room.lastEditorUserId 为 null）不归结：kb_docs.updatedBy 非空且全仓无
//      "system" 哨兵，编不出来就宁可不写（DESIGN §2.3-①）。
//   ② 归结必须入队：一律 withWriteTx，禁止裸定时器 + 直接 prisma 写（§3.7.1）。
//   ③ 失败不得静默：保留 dirty + 指数退避重试 + 显式日志（§3.7.4；与 defaults 那套
//      try/catch 吞错的惯例**相反** —— 这里丢的是用户已确认、不可重放的输入）。

import { parseCollabRoomId } from "@gx/shared-types";
import { prisma, withWriteTx } from "../db.js";
import { buildSearchText } from "../domain/kb.js";
import { saveDocContentTx, VersionConflictError } from "../domain/kbDocWrite.js";
import { applyDocUpdateToY } from "./docMerge.js";
import {
  blocksToMarkdown,
  docBlocksOf,
  hasBlocks,
  hydrateDocBlocks,
  markdownToBlocks,
} from "./docYjs.js";
import { registerRoomFlusher, type CollabRoom } from "./room.js";

/** 归结结果（房间空置 / tick / 关闭三条触发路径共用；HTTP PUT 注入后也复用它取版本号）。 */
export interface DocFlushResult {
  status: "written" | "unchanged" | "skipped" | "deferred";
  /** 落库后的 kb_docs.contentVersion；未写库时为当前值或 null。 */
  contentVersion: number | null;
  snapshotted: boolean;
  /** skipped/deferred 的原因（进日志，不进响应）。 */
  reason: string;
}

/** 冲突后最多重试一次（§3.2：捕获冲突 -> 归并库里的内容 -> 更新 base_version -> 重试）。 */
const MAX_ATTEMPTS = 2;
/** 失败退避阶梯（§3.7.4）；房间已空置或关闭时一律不看退避，必须落盘。 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

interface RetryState {
  fails: number;
  nextAt: number;
}

/** 退避状态跟着房间对象走（房间销毁即回收，不留 Map 泄漏）。 */
const retries = new WeakMap<CollabRoom, RetryState>();

function retryOf(room: CollabRoom): RetryState {
  const cur = retries.get(room);
  if (cur) return cur;
  const fresh: RetryState = { fails: 0, nextAt: 0 };
  retries.set(room, fresh);
  return fresh;
}

function noteFailure(room: CollabRoom): void {
  const st = retryOf(room);
  const wait = BACKOFF_MS[Math.min(st.fails, BACKOFF_MS.length - 1)];
  st.fails += 1;
  st.nextAt = Date.now() + wait;
  // 保留 dirty / coldDirty：下一轮防抖/tick 会再试（§3.7.4 失败不得静默）。
  room.dirty = true;
  room.coldDirty = true;
  console.error(
    `[collab] flush failed room=${room.roomId} consecutive=${st.fails} retryInMs=${wait}`,
  );
}

function skipped(reason: string, contentVersion: number | null = null): DocFlushResult {
  return { status: "skipped", contentVersion, snapshotted: false, reason };
}

/**
 * 文档房间的冷归结。注册为 "doc" 的 RoomFlusher，由 registry 在
 * 空置 / 30s tick / 优雅关闭三处调用；HTTP PUT 注入后也会直接调它取真实版本号。
 */
export async function flushDocRoom(room: CollabRoom, title?: string): Promise<DocFlushResult> {
  const ref = parseCollabRoomId(room.roomId);
  if (!ref || ref.kind !== "doc") return skipped("not-doc");

  const b = docBlocksOf(room.doc);
  // 房间还没播种（客户端尚未把内容铺进 Y）：此刻 Y 是空的，写成空内容等于把正文抹掉。
  if (!hasBlocks(b)) return skipped("no-blocks");
  // ① 没有最后编辑者就不写：updatedBy 非空且无哨兵可用。
  const editor = room.lastEditorUserId;
  if (!editor) return skipped("no-editor");

  const st = retryOf(room);
  // 空置（最后一人已离开）与关闭流程必须落盘，不被退避挡住。
  const force = room.conns.size === 0;
  if (!force && Date.now() < st.nextAt) {
    return { status: "deferred", contentVersion: null, snapshotted: false, reason: "backoff" };
  }

  let markdown = blocksToMarkdown(hydrateDocBlocks(b));
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await writeOnce(ref.objectId, room, markdown, editor, title);
      st.fails = 0;
      st.nextAt = 0;
      return res;
    } catch (e) {
      if (!(e instanceof VersionConflictError) || attempt === MAX_ATTEMPTS - 1) {
        noteFailure(room);
        throw e;
      }
      // ② 冲突不是终态（§3.2）：把库里被推进过的内容三方归并回 Y，base 前进后重试一次。
      const cur = await prisma.kbDoc.findUnique({
        where: { id: ref.objectId },
        select: { content: true, contentVersion: true },
      });
      if (!cur) {
        noteFailure(room);
        throw e;
      }
      applyDocUpdateToY(b, markdownToBlocks(room.baseContent ?? ""), markdownToBlocks(cur.content));
      room.baseVersion = cur.contentVersion;
      room.baseContent = cur.content;
      markdown = blocksToMarkdown(hydrateDocBlocks(b));
      console.warn(
        `[collab] version conflict merged room=${room.roomId} base=${room.baseVersion} retry=${attempt + 1}`,
      );
    }
  }
  noteFailure(room);
  throw new Error(`[collab] flush exhausted room=${room.roomId}`);
}

/**
 * 两段正文是否"实质未变"——**行尾换行不敏感**比较。
 *
 * 为什么需要它（而不是 `a === b`）：`blocksToMd`（packages/blocks/src/blocks.ts，
 * 全仓唯一的 Block[] -> Markdown 序列化出口）的收尾是
 * `out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"` —— 结果是**恒定带一个行尾
 * 换行**。而库里的历史正文未必带（HTTP/MCP 直写路径写进去的 `"# 标题"` 就一个都没有，
 * 也可能带多个）。
 *
 * 于是"打开协同再关上、一个字都没改"的冷归结，拿 `row.content === "# 标题"` 去比还原
 * 出来的 `"# 标题\n"`，严格相等不成立 -> 走 saveDocContentTx 落库 -> contentVersion +1
 * 并在版本历史里多出一个零差异快照。这是纯噪声，不是真实改动。
 *
 * 因此这里比较的是**去掉全部行尾 `\n` 之后**的正文：只差（一个或多个）行尾换行的，一律
 * 视为未变。正文中间的差异、以及 CRLF 与 LF 的差异不在此列 —— 那是真实改动，照旧写库。
 *
 * 不去改 `blocksToMd` 的出口（去掉那个 `+ "\n"`）：那是全仓大量 golden / round-trip
 * 测试的既定契约，波及面远大于此处。
 */
export function sameDocContent(a: string, b: string): boolean {
  return a.replace(/\n+$/, "") === b.replace(/\n+$/, "");
}

/**
 * 单次归结写：整篇内容一次进事务（条件更新 -> 自动快照 -> outbox -> nav 全在 saveDocContentTx 内）。
 * 内容无变化时**不写库**：避免"连进来什么都没改"也把 contentVersion 顶上去。
 */
async function writeOnce(
  docId: string,
  room: CollabRoom,
  markdown: string,
  editor: string,
  title?: string,
): Promise<DocFlushResult> {
  return await withWriteTx("collab.flush", async (tx) => {
    const row = await tx.kbDoc.findUnique({
      where: { id: docId },
      select: { kind: true, content: true, contentVersion: true },
    });
    if (!row) return skipped("doc-missing");
    // 尾换行不敏感：blocksToMd 出口恒定带一个尾换行，逐字节比会把"什么都没改"误判成改动。
    if (sameDocContent(row.content, markdown)) {
      room.baseVersion = row.contentVersion;
      // baseContent 存还原出来的 markdown（带尾换行）；下一次判定同样是尾换行不敏感，不会来回抖。
      room.baseContent = markdown;
      return { status: "unchanged", contentVersion: row.contentVersion, snapshotted: false, reason: "same-content" };
    }
    const saved = await saveDocContentTx(tx, {
      docId,
      kind: row.kind,
      currentVersion: row.contentVersion,
      content: markdown,
      searchText: buildSearchText(row.kind, markdown),
      userId: editor,
      title,
      baseVersion: room.baseVersion ?? undefined,
    });
    room.baseVersion = saved.contentVersion;
    room.baseContent = markdown;
    return { status: "written", contentVersion: saved.contentVersion, snapshotted: saved.snapshotted, reason: "ok" };
  });
}

/**
 * 房间在线时的整篇覆盖写（DESIGN §3.3）：把 content 作为一次 CRDT 更新注入房间并广播，
 * 再由房间统一归结落库 —— 不直接写库（否则 30s 后的冷归结会把这次写入静默吞掉），
 * 也不回 409（那会打断 MCP / AI 写入，构成功能回退）。
 *
 * 返回 injected=false 表示**不该走注入**（房间还没播种），调用方退回今天的直写路径。
 */
export async function injectDocContent(
  room: CollabRoom,
  content: string,
  userId: string,
  title?: string,
): Promise<{ injected: boolean; contentVersion: number | null; snapshotted: boolean }> {
  const b = docBlocksOf(room.doc);
  if (!hasBlocks(b)) return { injected: false, contentVersion: null, snapshotted: false };
  applyDocUpdateToY(b, markdownToBlocks(room.baseContent ?? ""), markdownToBlocks(content));
  // Y 事务的 origin 不是连接，lastEditor 不会被 update 事件认领，这里显式记 HTTP 侧的 actor。
  room.lastEditorUserId = userId;
  const res = await flushDocRoom(room, title);
  return { injected: true, contentVersion: res.contentVersion, snapshotted: res.snapshotted };
}

let registered = false;

/** 注册 doc 的冷归结实现（幂等；装配入口 collab/index.ts 在启动时调用一次）。 */
export function registerDocFlusher(): void {
  if (registered) return;
  // 包一层：RoomFlusher 声明返回 Promise<void>，而 flushDocRoom 的结果要给 HTTP PUT 回版本号用。
  registerRoomFlusher("doc", async (room) => {
    await flushDocRoom(room);
  });
  registered = true;
}

// apps/api/src/domain/formLayoutVersion.ts
// 表单设计器布局版本的领域逻辑：自动快照策略、按上限裁剪、净化与回写。
//
// 写法照 src/domain/kb.ts:81 maybeAutoSnapshotTx 的同构形态：
//   所有函数第一参都是 `client: DbTx` —— 调用方传交互事务 tx 就把这些写并进自己的事务，
//   传全局 prisma 就是单条语句的独立写。回调内【禁止】再调 runWrite/withWriteTx（自死锁）。
//
// 快照信封的构造/解析/纯净化在同目录 formLayoutSnapshot.ts（纯函数），此处原样再导出，
// 调用方只 import 本文件即可拿到全部对外面。

import type { DbTx } from "../db.js";
import {
  buildSnapshotEnvelope,
  parseJsonRecord,
  parseTabConfigs,
  serializeSnapshot,
  tabMemberIds,
  type FormLayoutTabSnapshot,
} from "./formLayoutSnapshot.js";

export * from "./formLayoutSnapshot.js";
export * from "./formLayoutSanitize.js";
export * from "./formLayoutReplay.js";

/** 自动快照时间窗：距上一版本超过 10 分钟才再存一版。 */
export const AUTO_INTERVAL_MS = 600_000;

/** 自动版本上限；超出后淘汰【最旧】的自动版本。手动版本（label 非 null）永不淘汰。 */
export const AUTO_MAX_VERSIONS = 50;

/** 参与淘汰判定所需的最小字段集。 */
interface VersionRef {
  id: string;
  version: number;
  label: string | null;
}

/**
 * 淘汰集合提取（纯函数，顺序敏感）。
 *
 * 纪律：
 *   1. 手动版本（label 非 null）**永远进 keep**，哪怕它是最旧的一条；
 *   2. 自动版本按 version 升序排列，超出上限的部分从【最旧】一端开始删（保留最新的 maxAuto 条）；
 *   3. 返回 ids 顺序与入参筛选顺序一致，便于单测断言"删的是哪几条"。
 * 把手动版本算进淘汰集合是 bug（用户显式"回退前备份"的档被静默删掉），这里从结构上排除。
 */
export function buildVersionExtractor(
  rows: readonly VersionRef[],
  maxAuto: number = AUTO_MAX_VERSIONS,
): { keep: string[]; drop: string[] } {
  const manual = rows.filter((r) => r.label !== null && r.label !== undefined);
  const autos = rows
    .filter((r) => r.label === null || r.label === undefined)
    .slice()
    .sort((a, b) => a.version - b.version);
  const overflow = Math.max(0, autos.length - Math.max(0, maxAuto));
  const drop = autos.slice(0, overflow).map((r) => r.id);
  const dropSet = new Set(drop);
  const keep = [...manual, ...autos].filter((r) => !dropSet.has(r.id)).map((r) => r.id);
  return { keep, drop };
}

/** 自动版本超上限时删最旧的；返回删除条数。手动版本不受影响。 */
export async function pruneAutoVersionsTx(
  client: DbTx,
  viewId: string,
  maxAuto: number = AUTO_MAX_VERSIONS,
): Promise<number> {
  const autos = await client.formLayoutVersion.findMany({
    where: { viewId, label: null },
    orderBy: [{ version: "asc" }, { createdAt: "asc" }],
    select: { id: true, version: true, label: true },
  });
  const { drop } = buildVersionExtractor(autos, maxAuto);
  if (drop.length === 0) return 0;
  const res = await client.formLayoutVersion.deleteMany({ where: { id: { in: drop } } });
  return res.count;
}

export interface FormLayoutVersionMeta {
  id: string;
  viewId: string;
  version: number;
  label: string | null;
  createdBy: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// 快照内容采集
// ---------------------------------------------------------------------------

/**
 * 从表内现存 tabs 字段反推 tabs 快照（服务端自采，不依赖前端上报）。
 * 只在真正要落版本时才被调（10 分钟窗 + 事务内），不是热路径。
 */
async function collectTabsSnapshotTx(
  client: DbTx,
  tableId: string,
): Promise<Record<string, FormLayoutTabSnapshot>> {
  const rows = await client.field.findMany({
    where: { tableId, type: "tabs", deletedAt: null },
    select: { id: true, tabsConfig: true },
  });
  const out: Record<string, FormLayoutTabSnapshot> = {};
  for (const r of rows) {
    const configs = parseTabConfigs(r.tabsConfig);
    const cards: string[] = [];
    // 用 tabMemberIds（rows 与 fieldIds 的并集）而不是 tabFieldIds：
    // 双写漂移时 cards 必须【包含】结构快照里的全部 id，否则那些 id 在探活时
    // 查不到、净化时又被判成已删 —— 回退就会静默少几张卡。
    for (const t of configs) {
      for (const id of tabMemberIds(t)) if (!cards.includes(id)) cards.push(id);
    }
    const entry: FormLayoutTabSnapshot = { cards, lazyTouched: [] };
    // 结构快照必须一并落下：cards 只是展平的成员集合，回退要靠它还原
    // "哪个字段在哪个 tab"、每个字段的宽度占比、以及用户显式拆出的行边界。
    if (configs.length > 0) entry.tabs = configs;
    out[r.id] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 自动快照
// ---------------------------------------------------------------------------

interface AutoSnapshotInput {
  /** 注入当前时间（单测用；不传取 Date.now()） */
  now?: number;
  /** 跳过时间窗判定，强制留一版（保存端点用：每次保存都该有档） */
  force?: boolean;
  /** 内容与最新一版完全一致时【不留档】（连点两次保存不该堆两条一样的版本） */
  skipIfIdentical?: boolean;
  /** 视图所在表；不传则按 viewId 查一次 */
  tableId?: string;
  /** 已更新后的 view.config JSON 字符串；不传则读库里的当前值 */
  viewConfigJson?: string;
  /** 视图类型；不传则读库里的当前值 */
  viewType?: string;
}

interface AutoSnapshotResult {
  created: boolean;
  version: number | null;
  /** 没留档的原因（排障与测试断言用；created=true 时为 undefined） */
  reason?: "no-view" | "no-detail-layout" | "within-window" | "identical";
}

/**
 * 布局保存时的自动版本策略（kb.maybeAutoSnapshotTx 的同构版）：
 *   - 视图不存在 / 非 detail 视图但没存过表单布局 → 不留版本（返回 created=false，不阻断主流程）
 *   - 无历史版本，或距上一版本超过 AUTO_INTERVAL_MS → 存一版（label=null）
 *   - 落版本后立即按 AUTO_MAX_VERSIONS 裁剪（只淘汰最旧的自动版本）
 *
 * 必须在【写完 view.config 之后】调用，这样信封里装的是刚保存的那份布局。
 */
export async function maybeAutoSnapshotLayoutTx(
  client: DbTx,
  viewId: string,
  userId: string,
  input: AutoSnapshotInput = {},
): Promise<AutoSnapshotResult> {
  let view: { tableId: string; type: string; config: string } | null = null;
  if (input.tableId === undefined || input.viewConfigJson === undefined || input.viewType === undefined) {
    view = await client.view.findUnique({
      where: { id: viewId },
      select: { tableId: true, type: true, config: true },
    });
    if (!view) return { created: false, version: null, reason: "no-view" };
  }
  const tableId = input.tableId ?? (view as { tableId: string }).tableId;
  const viewType = input.viewType ?? (view as { type: string }).type;
  const configJson = input.viewConfigJson ?? (view as { config: string }).config;
  const cfg = parseJsonRecord(configJson);
  // 版本管理跟的是「这个视图上有没有表单布局」，不是视图类型：记录抽屉读的是当前视图的
  // detailLayout，grid 视图上照样生效。detail 视图保持原行为（一律留档），非 detail 视图
  // 只有真存过 detailLayout 才留档——免得 grid 改个筛选/排序就在历史里堆垃圾版本。
  //
  // 判据必须用 nullish（== null）而不是 === undefined：views.ts 的 PATCH 是拿
  // parseViewConfig(v.config) 的全量默认值做 merge 的（recordService.ts:363 无条件回写
  // detailLayout: null），所以任何 grid 视图只要被人改过一次配置，config 里就会有
  // detailLayout: null 这个键。只判 undefined 的话，改个筛选也照样留一版空布局脏档。
  if (viewType !== "detail" && cfg["detailLayout"] == null) {
    return { created: false, version: null, reason: "no-detail-layout" };
  }

  const latest = await client.formLayoutVersion.findFirst({
    where: { viewId },
    orderBy: { version: "desc" },
    select: { version: true, createdAt: true, snapshot: true },
  });
  const now = input.now ?? Date.now();
  if (!input.force && latest && latest.createdAt.getTime() + AUTO_INTERVAL_MS > now) {
    return { created: false, version: null, reason: "within-window" };
  }

  const tabs = await collectTabsSnapshotTx(client, tableId);
  const envelope = buildSnapshotEnvelope(cfg["detailLayout"] ?? null, tabs);
  // 内容没变就不留档：连点两次保存、或保存后又改回去，都不该在历史里堆重复项。
  // 比对的是【信封序列化后的字符串】—— 键序在 buildSnapshotEnvelope 里已锚死，
  // 所以字符串相等等价于内容相等，不会因为书写顺序差异误判。
  if (input.skipIfIdentical && latest && latest.snapshot === serializeSnapshot(envelope)) {
    return { created: false, version: null, reason: "identical" };
  }
  const nextVersion = (latest?.version ?? 0) + 1;
  await client.formLayoutVersion.create({
    data: {
      viewId,
      version: nextVersion,
      label: null,
      snapshot: serializeSnapshot(envelope),
      createdBy: userId,
    },
  });
  await pruneAutoVersionsTx(client, viewId);
  return { created: true, version: nextVersion };
}


// 净化 / tabs 回写 / 回退 / 清理在 formLayoutReplay.ts（同构的一组，按职责拆文件）；
// 此处原样再导出，调用方只 import 本文件即可拿到全部对外面。
export * from "./formLayoutReplay.js";

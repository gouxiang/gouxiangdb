// apps/api/src/domain/formLayoutReplay.ts
// 表单设计器布局【保存侧】的落库原语：净化 + tabs 配置写入 + 版本清理。
//
// 与 formLayoutVersion.ts（采集/自动快照/裁剪）分开，是为了遵守单文件职责与行数门禁；
// 两者都只依赖 formLayoutSnapshot.ts 的纯函数，互不 import，调用方统一从 formLayoutVersion.js 取。
//
// 口径（总监裁定）：**不提供服务端 restore**。用户点「回退」= 把旧快照填回前端草稿区，
// 看过改过自己点保存才生效；生效一律走 POST /api/views/:viewId/detail-layout。
// 因此这里只有"用户显式保存"的写，没有"服务端替用户把历史快照落回生产"的写。

import type { TabConfig } from "@gx/shared-types";
import { prisma, type DbTx } from "../db.js";
import {
  collectReferencedFieldIds,
  isMissingTabsConfigColumn,
  parseTabConfigs,
  serializeSnapshot,
  type FormLayoutSnapshotEnvelope,
} from "./formLayoutSnapshot.js";
import { sanitizeEnvelopeWith, type LayoutAliveIndex } from "./formLayoutSanitize.js";

// ---------------------------------------------------------------------------
// 净化
// ---------------------------------------------------------------------------

/**
 * 净化快照：剔除已删字段留下的孤儿 item 与孤儿 tab slot。
 * 只做"剔除"，不改结构（不清空重排、不扁平嵌套、不重排列），见 sanitizeEnvelopeWith。
 */
export async function sanitizeLayoutTx(
  client: DbTx,
  tableId: string,
  envelope: FormLayoutSnapshotEnvelope,
): Promise<{ envelope: FormLayoutSnapshotEnvelope; removedFieldIds: string[]; removedTabKeys: string[] }> {
  // 探活集合必须和净化口径同源（collectReferencedFieldIds），否则会出现
  // "结构快照里引用的字段没被查探活 → 被当成已删静默剔除"的静默丢字段事故。
  const ids = collectReferencedFieldIds(envelope);
  const fields = ids.length
    ? await client.field.findMany({
        where: { tableId, id: { in: ids }, deletedAt: null },
        select: { id: true, type: true, tabsConfig: true },
      })
    : [];
  const alive: LayoutAliveIndex = {
    fieldIds: new Set(fields.map((f) => f.id)),
    tabIdsByContainer: new Map(
      fields
        .filter((f) => f.type === "tabs")
        .map((f) => [f.id, new Set(parseTabConfigs(f.tabsConfig).map((t) => t.id))]),
    ),
  };
  const res = sanitizeEnvelopeWith(envelope, alive);
  return { envelope: res.envelope, removedFieldIds: res.removedFieldIds, removedTabKeys: res.removedTabKeys };
}

/**
 * 把用户【显式保存】的 tabs 配置写进字段的 tabsConfig（保存路径专用）。
 *
 * 与已删除的 replayTabsTx 的区别：那是"服务端把历史快照回灌进当前数据"（替用户落库，
 * 已按产品语义否决）；这里是"用户点保存，落他自己提交的这份"，是保存事务的一步。
 *
 * 纪律：
 *   1. 只 update tabsConfig 一列，并【带 name 一起写回原值】（不触碰其它列、不破坏必填校验）；
 *   2. 调用方（路由）已先行校验键必须存在、未软删、type=tabs，这里只写不校验；
 *   3. tabsConfig 列缺失的环境（迁移没落齐）跳过并记进 skipped，不把保存打成 500。
 */
export async function saveTabsConfigTx(
  client: DbTx,
  tableId: string,
  tabs: Record<string, TabConfig[]>,
): Promise<{ updated: string[]; skipped: string[] }> {
  const keys = [...new Set(Object.keys(tabs ?? {}).filter((k) => k.length > 0))];
  if (keys.length === 0) return { updated: [], skipped: [] };

  const fields = await client.field.findMany({
    where: { tableId, id: { in: keys }, type: "tabs", deletedAt: null },
    select: { id: true, name: true },
  });
  const byId = new Map(fields.map((f) => [f.id, f]));
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const key of keys) {
    const field = byId.get(key);
    if (!field) {
      skipped.push(key);
      continue;
    }
    try {
      await client.field.update({
        where: { id: key },
        data: { tabsConfig: JSON.stringify(tabs[key] ?? []), name: field.name },
      });
      updated.push(key);
    } catch (err) {
      if (isMissingTabsConfigColumn(err)) {
        skipped.push(key);
        continue;
      }
      throw err;
    }
  }
  return { updated, skipped };
}

/** 视图被物理删除时清理其全部布局版本（在 views.delete 的 purge 事务里调用）。 */
export async function purgeVersionsTx(client: DbTx, viewId: string): Promise<number> {
  const res = await client.formLayoutVersion.deleteMany({ where: { viewId } });
  return res.count;
}

/** 非事务版入口：供不需要并入外层事务的调用方使用（走全局 prisma 的单条写）。 */
export async function createManualVersion(
  viewId: string,
  userId: string,
  snapshot: FormLayoutSnapshotEnvelope,
  label: string | null,
): Promise<{ id: string; viewId: string; version: number; label: string | null; createdBy: string; createdAt: Date }> {
  const latest = await prisma.formLayoutVersion.findFirst({
    where: { viewId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return prisma.formLayoutVersion.create({
    data: {
      viewId,
      version: (latest?.version ?? 0) + 1,
      label: label?.trim() || null,
      snapshot: serializeSnapshot(snapshot),
      createdBy: userId,
    },
  });
}

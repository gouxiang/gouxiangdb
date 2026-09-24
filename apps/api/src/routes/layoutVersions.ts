// apps/api/src/routes/layoutVersions.ts
// 表单设计器布局版本 + 布局保存：历史列表 / 单份预览 / 手动留档 / 事务化保存。
//
// 挂载点跟 /api/views 族（无 v1 前缀，存量契约，见 app.ts）：
//   GET  /api/views/:viewId/layout-versions          元数据列表（不含 snapshot 正文）
//   GET  /api/views/:viewId/layout-versions/:id      含 snapshot 的单条
//   POST /api/views/:viewId/layout-versions          手动留档（回退前保护备份）
//   POST /api/views/:viewId/detail-layout            布局保存（detailLayout + tabs 同事务落库）
//
// 保存端点为什么必须服务端一个事务：一次保存要写 1 个 view.config + N 个 field.tabsConfig，
// 前端串行走 N+1 个请求，中途失败会停在"布局改了一半"的脏态。

import { Hono } from "hono";
import { z } from "zod";
import { permissionsForRole } from "@gx/shared-types";
import { prisma, withWriteTx } from "../db.js";
import { requireCanView, HttpError } from "../guards.js";
import { requireSchemaDesign } from "../domain/authz/tableManageGuards.js";
import {
  buildSnapshotEnvelope,
  coerceTabConfigs,
  collectReferencedFieldIds,
  maybeAutoSnapshotLayoutTx,
  normalizeLayout,
  normalizeTabsWithIssues,
  parseJsonRecord,
  sanitizeLayoutTx,
  saveTabsConfigTx,
  serializeSnapshot,
  SNAPSHOT_ENVELOPE_VERSION,
  type FormLayoutVersionMeta,
} from "../domain/formLayoutVersion.js";

export const layoutVersions = new Hono();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const createSchema = z.object({
  snapshot: z.unknown(),
  label: z.string().trim().min(1).max(60).optional(),
});

async function baseIdOfView(viewId: string): Promise<string> {
  const v = await prisma.view.findUnique({
    where: { id: viewId },
    select: { table: { select: { baseId: true } } },
  });
  if (!v) throw new HttpError(404, "视图不存在");
  return v.table.baseId;
}

/** 统一序列化（列表与详情共用；详情额外带 snapshot）。 */
function serializeVersion(v: FormLayoutVersionMeta) {
  return {
    id: v.id,
    viewId: v.viewId,
    version: v.version,
    label: v.label,
    createdBy: v.createdBy,
    createdAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt),
  };
}

// ============ 列表 ============

layoutVersions.get("/:viewId/layout-versions", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  await requireCanView(c, baseId);

  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const items = await prisma.formLayoutVersion.findMany({
    where: { viewId },
    orderBy: { version: "desc" },
    take: limit,
    select: { id: true, viewId: true, version: true, label: true, createdBy: true, createdAt: true },
  });
  return c.json({ items: items.map(serializeVersion) });
});

// ============ 详情（含 snapshot）============

layoutVersions.get("/:viewId/layout-versions/:id", async (c) => {
  const viewId = c.req.param("viewId");
  const id = c.req.param("id");
  const baseId = await baseIdOfView(viewId);
  await requireCanView(c, baseId);

  const v = await prisma.formLayoutVersion.findFirst({ where: { id, viewId } });
  if (!v) throw new HttpError(404, "布局版本不存在");

  let snapshot: unknown = null;
  try {
    snapshot = JSON.parse(v.snapshot);
  } catch {
    snapshot = null; // 坏档不 500：返回 null，前端按"无法预览"处理
  }
  return c.json({ version: { ...serializeVersion(v), snapshot } });
});

// ============ 手动留档 ============

layoutVersions.post("/:viewId/layout-versions", async (c) => {
  const viewId = c.req.param("viewId");
  await baseIdOfView(viewId);
  const viewRow = await prisma.view.findUnique({ where: { id: viewId }, select: { tableId: true } });
  if (!viewRow) throw new HttpError(404, "视图不存在");
  const { userId } = await requireSchemaDesign(c, viewRow.tableId);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  const src = parsed.data.snapshot;
  if (src === null || typeof src !== "object" || Array.isArray(src)) {
    return c.json({ error: "snapshot 必须是对象" }, 400);
  }
  const raw = src as Record<string, unknown>;
  // 防御：容器值发成裸数组（把 TabConfig[] 直接当 tabs[容器id] 的值）时，旧实现会把它
  // 静默归一成 {} —— 整个容器的选项卡配置无声丢失、还返回 201。保护备份这份数据的唯一
  // 用途就是"回退时能还原"，静默丢失等于备份了个空壳，所以这里 fail-closed：直接 400。
  const { tabs: normalizedTabs, issues } = normalizeTabsWithIssues(raw["tabs"]);
  const malformed = issues.filter((i) => i.kind === "not-object").map((i) => i.key);
  if (malformed.length > 0) {
    return c.json({ error: "snapshot.tabs 的每个容器值必须是对象（结构数组应嵌在容器的 tabs 键里）", keys: malformed }, 400);
  }
  const envelope = buildSnapshotEnvelope(
    raw["layout"],
    normalizedTabs,
    SNAPSHOT_ENVELOPE_VERSION,
  );
  const label = parsed.data.label?.trim() || null;

  // 版本号 = max+1，与建版本同事务；手动版本不参与裁剪（pruneAutoVersionsTx 只挑 label=null）。
  const created = await withWriteTx("formLayoutVersion.create", async (tx) => {
    const latest = await tx.formLayoutVersion.findFirst({
      where: { viewId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return tx.formLayoutVersion.create({
      data: {
        viewId,
        version: (latest?.version ?? 0) + 1,
        label,
        snapshot: serializeSnapshot(envelope),
        createdBy: userId,
      },
    });
  });
  return c.json({ version: serializeVersion(created) }, 201);
});

// ============ 布局保存（事务）============

const detailLayoutSchema = z.object({
  detailLayout: z.unknown(),
  tabs: z.record(z.array(z.unknown())).optional(),
});

type TabConfigList = ReturnType<typeof coerceTabConfigs>;

/**
 * 保存详情页/表单布局：detailLayout 进 view.config，tabs 配置逐个进 field.tabsConfig，
 * 全部在一个 withWriteTx 里（要么全生效要么全不生效），最后留一版快照。
 *
 * 顺序说明：规格写的是"写库 → 净化"，实际实现是**先净化再写库** —— 净化是剔除已删字段
 * 留下的孤儿引用，先净化才能保证落库的与最终生效的是同一份，快照也不会拍到未净化的版本。
 *
 * 权限沿用 views.patch 的判定：personal 视图允许成员改自己的配置，
 * 非 personal 且无 canManageSchema → 403。不用 requireCanManageSchema（那会把
 * personal 视图的普通成员挡在门外，与既有 PATCH 行为不一致）。
 */
layoutVersions.post("/:viewId/detail-layout", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  const { userId, role } = await requireCanView(c, baseId);

  const v = await prisma.view.findUnique({ where: { id: viewId } });
  if (!v) throw new HttpError(404, "视图不存在");

  const perm = permissionsForRole(role);
  if (v.lockMode !== "personal" && !perm.canManageSchema) {
    throw new HttpError(403, "该视图已锁定，当前角色无权修改");
  }

  const parsed = detailLayoutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  // ① 归一化。detailLayout 传了却解析不出 rows → 400，不静默降级成"清空布局"。
  const rawLayout = parsed.data.detailLayout;
  const layout = normalizeLayout(rawLayout);
  if (rawLayout !== null && rawLayout !== undefined && layout === null) {
    return c.json({ error: "detailLayout 结构不合法" }, 400);
  }
  const tabs: Record<string, TabConfigList> = {};
  for (const [key, value] of Object.entries(parsed.data.tabs ?? {})) {
    if (key.length === 0) continue;
    if (!Array.isArray(value)) return c.json({ error: "tabs 的每个值必须是数组" }, 400);
    const cfg = coerceTabConfigs(value);
    if (cfg.length !== value.length) return c.json({ error: `tabs[${key}] 含非法选项卡定义` }, 400);
    tabs[key] = cfg;
  }

  // ② 组装信封（此时还没净化），只为拿到"被引用到的全部字段 id"做预校验
  const probe = buildSnapshotEnvelope(
    layout,
    Object.fromEntries(
      Object.entries(tabs).map(([k, cfg]) => [k, { cards: cfg.flatMap((t) => t.fieldIds), lazyTouched: [], tabs: cfg }]),
    ),
  );
  const ids = collectReferencedFieldIds(probe);

  // ③ 预校验（事务外，为了能把明细回进 400 响应体）：字段存在且未软删、tabs 键是 tabs 字段
  const aliveRows = ids.length
    ? await prisma.field.findMany({
        where: { tableId: v.tableId, id: { in: ids }, deletedAt: null },
        select: { id: true, type: true },
      })
    : [];
  const alive = new Map(aliveRows.map((f) => [f.id, f.type]));
  const missing = ids.filter((id) => !alive.has(id));
  if (missing.length > 0) {
    return c.json({ error: "字段不存在或已删除", fieldIds: missing.slice(0, 20) }, 400);
  }
  const badTabKeys = Object.keys(tabs).filter((k) => alive.get(k) !== "tabs");
  if (badTabKeys.length > 0) {
    return c.json({ error: "tabs 的键必须是选项卡字段", fieldIds: badTabKeys }, 400);
  }

  const result = await withWriteTx("detailLayout.save", async (tx) => {
    // ④ 事务内复核（防并发删字段）：任一 id 失效即整事务回滚，不留半截布局
    const rows = ids.length
      ? await tx.field.findMany({
          where: { tableId: v.tableId, id: { in: ids }, deletedAt: null },
          select: { id: true },
        })
      : [];
    if (rows.length !== ids.length) throw new HttpError(400, "字段不存在或已删除");

    // ⑤ 净化：剔除已删字段的孤儿引用（预校验通过后理论上为空，留作纵深防御）
    const clean = await sanitizeLayoutTx(tx, v.tableId, probe);

    // ⑥ 写库：view.config 只改 detailLayout 一个键；字段只改 tabsConfig 一列
    const cfg = parseJsonRecord(v.config);
    cfg["detailLayout"] = clean.envelope.layout;
    const configJson = JSON.stringify(cfg);
    await tx.view.update({ where: { id: viewId }, data: { config: configJson } });
    const tabWrites: Record<string, TabConfigList> = {};
    for (const [key, entry] of Object.entries(clean.envelope.tabs)) {
      if (entry.tabs && entry.tabs.length > 0) tabWrites[key] = entry.tabs;
    }
    const written = await saveTabsConfigTx(tx, v.tableId, tabWrites);

    // ⑦ 留档：保存即留版（force 跳过 10 分钟窗）；内容没变则不留（skipIfIdentical）
    const snap = await maybeAutoSnapshotLayoutTx(tx, viewId, userId, {
      force: true,
      skipIfIdentical: true,
      tableId: v.tableId,
      viewType: v.type,
      viewConfigJson: configJson,
    });
    return { snap, written, clean };
  });

  // skipped 一定要回给前端：它是"布局存了、但某几个选项卡容器没写进去"（键没解析到 tabs
  // 字段，或 tabsConfig 列在库里不存在）。不回 = 200 成功但用户配置无声丢了，用户永远不知道。
  return c.json({
    ok: true,
    version: result.snap.version,
    removedFieldIds: result.clean.removedFieldIds,
    tabsUpdated: result.written.updated,
    skipped: result.written.skipped,
  });
});

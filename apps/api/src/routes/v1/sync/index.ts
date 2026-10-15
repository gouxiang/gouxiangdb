// /api/v1/sync：离线优先 + 操作级双向同步服务端面（YN0 地基）。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §11/§13。
//
// 挂载纪律（与 /api/v1/search「恒挂载 + 请求期闸门」同款，刻意区别于按启动 flag 静态摘挂）：
//   - 本子路由在 app.ts 中【独立于企业双 flag】恒挂到 mount 的 /api/v1/sync；
//     即使 GX_ENTERPRISE_ORG/NAV 全 off，同步面仍按自己的总门 GX_SYNC_SERVER 决定可达性。
//   - 组首中间件每次请求读 env 判定（syncServerEnabled）：off（出厂默认）-> 在【任何 DB
//     访问之前】直接 404 SYNC_DISABLED，因此默认安装不写任何 sync_* 表、不暴露同步能力，
//     旧行为逐字节不变；on -> 继续鉴权链与各子端点。
//   - 运维改 env 后无需重启即生效；测试也能在同一进程内切开/关（config 是冻结快照）。
//
// 分期：YN0 只立总门 + 鉴权 + 能力探针（证明可达性与开关语义）；subscribe/snapshot/pull
// 在 YN2 接入，push/resolve/incoming/visibility 在 YN4/YN5 接入。未落地的路径不在此预注册，
// 以免客户端把"还没做"误当成"已支持"。

import { Hono } from "hono";
import { syncServerEnabled } from "../../../configSync.js";
import { HttpError } from "../../../httpError.js";
import { requireActiveUser } from "../../../middleware/authActive.js";
import { VERSION } from "../../../version.js";
import { buildBaseSnapshot, markSnapshotDone, subscribeBase, authorizeBaseRead } from "../../../domain/sync/snapshot.js";
import { pullBaseOps } from "../../../domain/sync/pull.js";

export const syncRoutes = new Hono();

// ① 总门：最先执行，off 即 404，且短路在鉴权/DB 之前（默认零行为、零额外写）。
syncRoutes.use("*", async (c, next) => {
  if (!syncServerEnabled()) {
    // 与统一 404 信封一致：{error,code,path}（NOT_FOUND 不透露"同步存在但关闭"以外的信息）。
    throw new HttpError(404, "同步服务未启用", "SYNC_DISABLED");
  }
  return next();
});

// ② 鉴权：同步面全部要求登录且账号 ACTIVE/tv 匹配（与 v1 主链同源，令牌头 X-GX-Token/Authorization 均收）。
syncRoutes.use("*", requireActiveUser);

// ③ 能力探针：on 且登录后可达，供客户端（Mac 侧车/节点）判定本节点是否支持离线同步与当前阶段。
//    不触碰任何 sync_* 表（只读 env/版本），故即便 on 也不产生写入。
syncRoutes.get("/", (c) => {
  const auth = c.get("auth");
  return c.json({
    apiVersion: "v1",
    sync: true,
    // 阶段标识随 YN 推进刷新；客户端据此判断可用端点集。
    phase: "YN2",
    serverVersion: VERSION,
    auth: {
      userId: auth.userId,
      workspaceId: auth.workspaceId,
    },
  });
});

// ───────────────────────── YN2a：订阅 + 权限裁剪基线快照 ─────────────────────────

/** POST /subscribe {clientId, scopeType:"base", scopeId:<baseId>} → 订阅记账 + 当前游标/权限版本。 */
syncRoutes.post("/subscribe", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => null)) as
    | { clientId?: unknown; scopeType?: unknown; scopeId?: unknown }
    | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const scopeType = body?.scopeType;
  const scopeId = typeof body?.scopeId === "string" ? body.scopeId.trim() : "";
  if (!clientId || !scopeId) throw new HttpError(400, "缺少 clientId 或 scopeId", "SYNC_BAD_REQUEST");
  // YN2 只支持按 base 订阅（kb/doc 走协同轨，后续阶段）。
  if (scopeType !== "base") throw new HttpError(400, "本期仅支持 scopeType=base", "SYNC_BAD_SCOPE");

  const result = await subscribeBase(auth.userId, clientId, scopeId);
  return c.json({ result });
});

/** GET /snapshot?baseId=&clientId=&limit= → 按【当前权限】裁剪的基线快照（与在线列表同口径）。 */
syncRoutes.get("/snapshot", async (c) => {
  const auth = c.get("auth");
  const baseId = (c.req.query("baseId") ?? "").trim();
  if (!baseId) throw new HttpError(400, "缺少 baseId", "SYNC_BAD_REQUEST");
  const limitRaw = Number(c.req.query("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
  // clientId 可选：带了就把该订阅标记为快照已完成（游标推进由 pull 的 after 负责）。
  const clientId = (c.req.query("clientId") ?? "").trim() || null;

  const page = await buildBaseSnapshot(auth.userId, baseId, limit ? { limit } : {});
  // clientId 可选：带了就标记快照完成（订阅尚未建立时 updateMany 命中 0 行，不影响快照成功）。
  if (clientId) await markSnapshotDone(clientId, baseId);
  return c.json({ result: page });
});

/**
 * GET /pull?baseId=&after=<seq>&clientId=&limit= → 游标增量 oplog，按【当前权限】逐条过滤。
 * after 缺省 0（未做过快照的客户端会从最早 op 拉，但通常先 snapshot 再以 snapshotSeq 为起点）。
 */
syncRoutes.get("/pull", async (c) => {
  const auth = c.get("auth");
  const baseId = (c.req.query("baseId") ?? "").trim();
  if (!baseId) throw new HttpError(400, "缺少 baseId", "SYNC_BAD_REQUEST");
  const afterRaw = (c.req.query("after") ?? "0").trim();
  if (!/^\d+$/.test(afterRaw)) throw new HttpError(400, "after 必须是非负整数", "SYNC_BAD_CURSOR");
  const after = BigInt(afterRaw);
  const limitRaw = Number(c.req.query("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 500;
  const clientId = (c.req.query("clientId") ?? "").trim() || null;

  // 当前库门裁决（enter）；pull 内部再逐表按当前 r/行/字段权限二次过滤。
  const access = await authorizeBaseRead(auth.userId, baseId);
  const page = await pullBaseOps(auth.userId, access, clientId, baseId, after, limit);
  return c.json({ result: page });
});

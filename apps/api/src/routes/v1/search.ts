// M5/S6 /api/v1/search 挂载骨架（纯门控占位，零检索实现）。
//
// 挂载纪律（M5 计划 §6/§17-S6）：本子路由仅在 config.m5Search !== "off" 时由
// routes/v1/index.ts 条件挂载；off 时 /api/v1/search 落 v1 自身 404（与 nav/org 未启用同款）。
//
// 本期 S6 骨架约束（S7 才接真实检索）：
//   - 禁止 import domain/search 下任何实现（searchStore/indexer/embedding/queryPlan 等），
//     保证本文件只依赖 config 标志与 v1 鉴权链，不建 search.db、不加载 vec0、不出网、不起 worker；
//   - on/shadow 两态本文件行为相同：GET / 一律 501 + {error,code} 项目错误信封，
//     code=m5_search_not_implemented；shadow 的对拍语义 S7 随真实 query 一起落地。
//
// S7 接线点：在此文件按 §9 契约接入 domain/search/query.ts——
//   GET /?q=&type=all|record|doc|canvas&mode=auto|vector|fts&limit=20
//   先 M4 scope 收敛 -> FTS/LIKE/vec 白名单内三路召回 -> RRF 融合 -> decideMany 二次校验；
//   shadow 态另调旧 /api/search 逻辑做 drift 对拍（只记日志，不改变响应）。

import { Hono } from "hono";
import { config } from "../../config.js";

export const searchRoutes = new Hono();

searchRoutes.get("/", (c) => {
  // 能进入本处理器说明 m5Search 为 on/shadow（off 时子路由根本未挂载）。
  // S7 前两态统一 501：占位显式告知"路由已开、检索未实现"，不伪装成 200 空结果。
  return c.json(
    {
      error: "统一检索尚未实现（M5 路由门已挂载，S7 接入）",
      code: "M5_SEARCH_NOT_IMPLEMENTED",
      mode: config.m5Search,
    },
    501,
  );
});

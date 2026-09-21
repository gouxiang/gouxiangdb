// apps/api/src/routes/public.ts
// 公开分享路由（匿名可访问，无需 JWT）统一分发。
//
// 一个对象族一个文件，本文件只做「令牌 -> 对象族 -> 交给谁」：
//   GET /s/:token                            分发：doc=publicDoc.ts / table=本文件 / base=本文件
//   GET /s/:token/doc/:docId                 子树内文档（publicDoc.ts）
//   GET /s/:token/ref/:docId                 引用闭包内文档（publicDoc.ts）
//   GET /s/:token/records                    数据表分享翻页（publicTable.ts）
//   POST|PATCH|DELETE /s/:token/records[/:id] 数据表分享写入（publicTable.ts，需可编辑）
//   PUT  /s/:token/doc/:docId/content        文档正文保存（publicDoc.ts，可编辑档位 + 乐观锁）
//
// 权限完全以分享设置为准，与团队成员权限无关。不暴露成员邮箱、不暴露库内未分享内容。
// 数据表分享的可见范围 = 库级 shareEnabled && 表级 shareEnabled；任一级关掉，链接当次即失效。

import { Hono } from "hono";
import { errorResponse } from "../guards.js";
import { resolveShareTarget, shareableTables } from "../domain/share/shareLinkLookup.js";
import { resolveTableShareCaps } from "../domain/share/shareCaps.js";
import { readSharedTable, sharePage } from "../domain/share/externalRecords.js";
import { docShareResponse } from "./publicDoc.js";
import { publicDocRoutes } from "./publicDoc.js";
import { publicTableRoutes } from "./publicTable.js";
import { publicEmbedRoutes } from "./publicEmbed.js";

export const pub = new Hono();

// 注册顺序：挂载的子路由先匹配（它们的路径都比 /s/:token 更长，不会互相遮蔽）。
pub.route("/", publicDocRoutes);
pub.route("/", publicTableRoutes);
pub.route("/", publicEmbedRoutes);

// 历史导出面保持不动：routes/__tests__/public.test.ts 从本文件取这两个纯函数。
export { collectRefDocIds, buildShareReferenceClosure } from "./publicDoc.js";

// 分享根：按对象族分发
pub.get("/s/:token", async (c) => {
  try {
    const token = c.req.param("token");
    const target = await resolveShareTarget(token);

    if (target.type === "kb_doc") {
      return c.json(await docShareResponse(token, target.doc));
    }

    if (target.type === "table") {
      const caps = await resolveTableShareCaps(target.link, target.table.id);
      const page = sharePage({ limit: c.req.query("limit"), offset: c.req.query("offset") });
      const payload = await readSharedTable(
        { tableId: target.table.id, viewId: target.link.viewId, limit: page.limit, offset: page.offset },
        caps,
        target.table,
      );
      return c.json({ ...payload, token });
    }

    // 库级分享链接：只读外壳——库名 + 该库内已开启分享的表清单，不含任何记录数据。
    // 要看数据必须打开某张表的分享链接，避免一条库级链接把全库数据摊开。
    return c.json({
      kind: "base",
      token,
      mode: "view",
      canEdit: false,
      base: target.base,
      tables: await shareableTables(target.base.id),
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

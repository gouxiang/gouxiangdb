// 检索总门的运行期便捷封装（DI 封装层，不含判定逻辑）。
//
// 为什么单独一个文件：searchGate.ts 必须保持「纯函数 + 注入 prisma」的可单测形态（判定矩阵
// 单测直接在 node 里跑，不希望 import 它就牵出 PrismaClient）。而 MCP 侧的可用性门（catalog.ts
// 的 record.search）需要拿到进程内的 prisma/jwtSecret——把这两个依赖钉在本文件，供 mcp/** 调用，
// 避免在 mcp/** 里裸 import db.js。
//
// 判定本身仍 100% 委托给 searchGate.ts（单一真源，不另起一套口径）。

import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { loadSearchGateFlag } from "./searchGate.js";
import type { SearchGateFlag } from "@gx/shared-types";

/**
 * 统一检索当前是否可用（请求期判定；db 覆盖优先于 env）。
 * 读配置失败一律回落 env 口径（同 searchGate.loadSearchGateFlag 的保守语义）。
 */
export async function isUnifiedSearchEnabled(envFlag: SearchGateFlag = config.m5Search): Promise<boolean> {
  return (await loadSearchGateFlag(prisma, config.jwtSecret, process.env, envFlag)) !== "off";
}

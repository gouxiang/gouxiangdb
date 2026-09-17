// M5 reindex / S12 重播共享类型（独立成文件，避免 reindex <-> reindexPump 循环依赖）。

import type { PrismaClient } from "@prisma/client";
import type { SearchStore } from "./searchStore.js";
import type { EmbeddingProvider } from "./embedding/types.js";

export type ReindexEntityType = "record" | "doc" | "canvas";

export interface ReindexDeps {
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  appDir: string;
  jwtSecret: string;
  workspaceId?: string;
  /** 测试注入：覆写现役 store（生产走单例）。 */
  activeStore?: SearchStore;
  /** 测试注入：覆写 search.db 物理路径（生产按 env/dataDir 解析）。 */
  searchPath?: string;
  /** 测试注入 mock cloud（不触外网）；不给则按配置构造。 */
  provider?: EmbeddingProvider | null;
  /** 测试注入：env 覆盖路径（GX_VEC_EXT_PATH）。 */
  vecExtPath?: string;
  now?: () => Date;
  /** 全量重建进度回调（每灌完一个实体；观测/测试用，可 await 以在灌库中途断言旧库仍可读）。 */
  onProgress?: (done: number, total: number) => Promise<void> | void;
}

export interface ReindexScope {
  /** 全量=省略；单实体=record|doc|canvas。 */
  type?: ReindexEntityType;
  entityId?: string;
}

export interface ReindexResult {
  scope: ReindexScope;
  mode: "single" | "full";
  entities: number;
  chunksWritten: number;
  vecWritten: number;
  vecDebt: number;
  swapped: boolean;
  activePath: string;
}

// /api/v1/admin/update/* 共享运行时：UpdateService 进程内单例 + 启动期 env 快照。
//
// 单独成文件的原因（S4）：下载端点 GET /admin/update/download 是【仅验票】的公开路由，
// 必须在 app.ts 于 v1（全局 requireActiveUser）之前挂载，否则原生导航不带登录头会被 401；
// 而 status / download-ticket 是 v1 内的 owner 路由。两条路由文件共用这里的同一个 service
// 单例，清单 TTL 缓存（§5.4）才能跨「检查→换票→下载」真正复用。
//
// env 在【模块加载期】快照冻结：通道身份（GX_UPDATE_CHANNEL/GX_DEPLOY_CHANNEL/TRIM_*）是
// 进程启动期事实，运行期不变；加载期取（而非请求期）也避免请求间 process.env 漂移污染。

import { config } from "../../config.js";
import { UpdateService } from "../../domain/update/service.js";

export const STARTUP_ENV: NodeJS.ProcessEnv = { ...process.env };

let serviceSingleton: UpdateService | null = null;

export function updateService(): UpdateService {
  if (!serviceSingleton) {
    serviceSingleton = new UpdateService(config.update, { env: STARTUP_ENV });
  }
  return serviceSingleton;
}

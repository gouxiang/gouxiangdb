// apps/api/src/domain/update/sourceFactory.ts
// 按 config 选择更新源（DESIGN §5.3）：
//   source=static                      → StaticUpdateSource(authed=false)
//   source=gitea + GX_UPDATE_MANIFEST_URL（覆盖）→ StaticUpdateSource(authed=true，私有覆盖地址)
//   source=gitea（默认）               → GiteaUpdateSource
import type { UpdateConfig } from "../../configUpdate.js";
import { GiteaUpdateSource, type GiteaSourceDeps } from "./sourceGitea.js";
import { StaticUpdateSource, type StaticSourceDeps } from "./sourceStatic.js";
import type { UpdateSource } from "./source.js";

export interface SourceDeps extends GiteaSourceDeps, StaticSourceDeps {}

export function createUpdateSource(cfg: UpdateConfig, deps: SourceDeps = {}): UpdateSource {
  if (cfg.source === "static") {
    return new StaticUpdateSource(cfg, false, deps);
  }
  if (cfg.manifestUrl) {
    // gitea 源但强制覆盖清单地址（内网镜像）：资产仍私有，带 token。
    return new StaticUpdateSource(cfg, true, deps);
  }
  return new GiteaUpdateSource(cfg, deps);
}

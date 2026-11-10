// apps/api/src/domain/update/sourceFactory.ts
// 按 config 选择更新源（DESIGN §5.3）：
//   source=static                      → StaticUpdateSource(authed=false)
//   source=github                      → GithubUpdateSource（匿名公开仓，authed 恒 false）
//   source=gitea + GX_UPDATE_MANIFEST_URL（覆盖）→ StaticUpdateSource(authed=true，私有覆盖地址)
//   source=gitea（默认）               → GiteaUpdateSource
// 注意：不配 github（默认 gitea）时分派结果与旧版逐字一致，默认行为零变化。
import type { UpdateConfig } from "../../configUpdate.js";
import { GiteaUpdateSource, type GiteaSourceDeps } from "./sourceGitea.js";
import { GithubUpdateSource, type GithubSourceDeps } from "./sourceGithub.js";
import { StaticUpdateSource, type StaticSourceDeps } from "./sourceStatic.js";
import type { UpdateSource } from "./source.js";

export interface SourceDeps extends GiteaSourceDeps, StaticSourceDeps, GithubSourceDeps {}

export function createUpdateSource(cfg: UpdateConfig, deps: SourceDeps = {}): UpdateSource {
  if (cfg.source === "static") {
    return new StaticUpdateSource(cfg, false, deps);
  }
  if (cfg.source === "github") {
    // 匿名公开仓：不读 token、不做 manifestUrl 私有覆盖（公开源无内网镜像语义）。
    return new GithubUpdateSource(cfg, deps);
  }
  if (cfg.manifestUrl) {
    // gitea 源但强制覆盖清单地址（内网镜像）：资产仍私有，带 token。
    return new StaticUpdateSource(cfg, true, deps);
  }
  return new GiteaUpdateSource(cfg, deps);
}

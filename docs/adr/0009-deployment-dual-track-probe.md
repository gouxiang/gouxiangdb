# ADR-0009：部署形态双轨（裸机为主，容器经探针评估）

**状态（Status）**：Proposed / 占位（M0 仅落地探针；正文随容器决策补全，2026-09-13）
**作者**：后端（mvp-dev-expert-team-backend）

---

## 背景（Background）

GouXiangDB M0 的确定交付路径是裸机 systemd + Caddy（[ADR-0003](0003-bare-metal-topology.md)），
原因是单包、零外部依赖、SQLite 单写者与单机拓扑最契合。但部分企业客户环境只接受容器化交付，
架构（ARCH §4.6）因此保留「裸机 / 容器」双轨可能。容器方案在 M0 既不被否决也不交付：
Compose/镜像属 P2/P3 范围，且以客户接受 Docker 运行时为前提。

## 决策（Decision）

- M0 **只交付一个只读的 Docker 可用性探针** `deploy/probe/docker-probe.sh`，在客户机输出
  `docker-ready` / `docker-installable` / `docker-unavailable` 三态，作为是否值得走容器轨的事实依据。
- 探针**不安装任何东西、不产出 compose/Dockerfile 交付物**。
- 容器化的正式决策（镜像基线、数据卷、单容器内 Caddy+Node 还是 sidecar、升级与备份如何映射）
  待收集到明确客户需求与三态证据后，在本 ADR 补全正文并升级为 Accepted；届时再新增 compose/镜像物。

> 占位说明：本号按生产化架构表预留给「部署双轨」。当前仅登记探针与未决项，避免提前固化容器设计。

## 后果（Consequences）

- M0 不背容器维护成本，也不在客户未接受 Docker 时产生死配置（仓库内不预置 compose）。
- 三态证据让后续容器决策基于真实环境而非假设。
- 未决：若走容器，SQLite 数据必须挂持久卷且仍保持单写者；备份 timer 是入容器还是主机 cron
  需要在正文决策；这些目前刻意不实现。

## 相关（Related）

- [ADR-0003](0003-bare-metal-topology.md)：M0 主路径裸机拓扑
- 探针：`deploy/probe/docker-probe.sh`；说明：`docs/runbooks/deploy.md`

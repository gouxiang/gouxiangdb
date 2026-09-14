# ADR-0010：异地备份 age X25519 收件人加密（解密身份与备份机分离）

**状态（Status）**：Accepted（M0 落地，2026-09-13，S6 实现）

> **2026-09-12 NAS 重定向状态补充（项目总监 92d0a34 决策驱动，非作者自行翻状态）**：
> 依据 `docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md` §3，本 ADR 的机制设计与代码**已就位且保留**，
> 但**产品姿态＝接口预留、默认不激活**：
>
> - 本期**不作为已交付的容灾能力**，不在 M0/M1 出口验收中要求；
> - 部署**不 enable** `gouxiangdb-backup.timer` 的异地投递（timer 本身也不随部署自动启用，见 ADR-0007 修订与 runbook）；
> - env 模板中 `BACKUP_ENCRYPT_OFFSITE` / `AGE_RECIPIENT` / `AGE_BIN` / `GX_OFFSITE_TARGET` 标注为"可选扩展，默认不启用"；
> - 未来需要异地容灾时，按已冻结的 **`BackupTransport` 契约**（PLAN-ADJUST §3.2）新增投递实现 + 填配置 + enable timer 即可启用，**无需重构快照核心**。现有 age-rsync 分支即该契约一个已写好但默认不注册的实现样例。
>
> 下方"决策/后果"正文（age X25519 收件人机制、密钥分离、rc=3 fail-loud 等）**保留不动**，仍是未来启用时的有效设计。

**作者**：后端（mvp-dev-expert-team-backend）
**编号说明**：ADR-0010 在生产化架构表中即预分配给「异地备份加密」；本号正文随 S6 补齐。
0011–0020 由企业版架构（§10.4）占用，本批工程 ADR 顺沿 0021。

---

## 背景（Background）

[ADR-0007](0007-sqlite-online-backup.md) 的本地快照与库同机，无法防整机损毁/失窃/机房事故，
需要把备份推到异机或异地存储。异地拷贝会把**包含全部客户业务数据的库文件**带出受控主机，
由此产生两个必须正面回答的安全问题：

1. 备份在传输通道与异地落点可能被第三方看到（对象存储运维、网络中间人、移动介质丢失）。
2. 谁持有「能解密」的凭据，就等于谁能读全部历史数据；加密能力与解密能力必须分离，
   否则备份机一旦被攻破即全盘泄露。

候选方案：GPG 公钥、age X25519、压缩不加密、外部 KMS 信封加密。M0 需要一个无重型信任链、
可脚本化、单二进制、公私钥模型清晰的工具；KMS 引入云厂商依赖违背零外部依赖原则。

## 决策（Decision）

采用 [age](https://github.com/FiloSottile/age) 的 **X25519 收件人（recipient）模式**做异地加密，
并强制「加密身份在备份机、解密身份离线分离」：

1. **只在备份机放置公钥（recipient，`age1...`）**。备份脚本对
   `tar -czf` 出的（库 + uploads）归档执行 `age -r <AGE_RECIPIENT> -o offsite-<stamp>.tar.gz.age`。
   公钥只能加密、**无法解密**，泄露公钥不危害已生成备份的机密性。
2. **X25519 解密私钥（identity）绝不放在备份机、绝不写入 env.conf/发布包/仓库**；
   由运维离线保管（如离线介质 + 口令/分人保管）。只有真正做异地恢复时才在受控机导入 identity。
3. **可选开关 + fail-loud**：`BACKUP_ENCRYPT_OFFSITE=true` 时 `AGE_RECIPIENT` 必填；
   找不到 `age` 二进制或收件人缺失时，脚本以**退出码 3 明确失败**，不静默产出明文异地件、
   也不假装加密成功。本地明文快照（daily/weekly）仍已完成，加密失败只影响异地这一段。
4. **加密边界**：加密对象是「数据库快照 + uploads tar」的 gzip tar 包；加密前已通过 ADR-0007
   的 integrity/迁移/计数/sha256 校验，恢复时先解密解 tar，再走同一套 verify-restore 对账。
5. 推送目标由 `GX_OFFSITE_TARGET` 指定（rsync 远端或本地路径）；未配置或推送失败时，
   加密件停留本地 spool 并告警，不丢已生成的加密产物。

密钥生命周期：identity 生成（`age-keygen`）在离线机完成；公钥登记进部署 env.conf，
私钥离线登记进密钥台账并做分人/异地副本；轮换时用新旧多个 recipient 加密一个过渡期。

## 后果（Consequences）

正面：

- 备份机被攻破只泄露「公钥 + 密文」，无私钥无法解密，实现加密/解密职责分离。
- age 单二进制、无 PGP 信任网复杂度，适合内网脚本化；X25519 为现代强原语。
- fail-loud 杜绝「以为加密了其实是明文外发」的静默安全事故。

负面/约束：

- **私钥丢失 = 异地备份永久不可解密**，因此 identity 的离线冗余保管本身是关键运维责任。
- 增加对 `age` 可执行文件的依赖（可用 `AGE_BIN` 指定路径，或随发布物 `bin/age` 分发）；
  目标机无 age 时必须显式安装，否则异地加密段以 rc=3 失败。
- 加密只保护机密性与（由 age AEAD 提供的）完整性，不替代 ADR-0007 的应用层校验；
  恢复仍需 verify-restore 对账。
- 轮换/多收件人策略需要运维流程配合，工具本身不做密钥管理服务。

## 相关（Related）

- [ADR-0007](0007-sqlite-online-backup.md)：本地一致性快照是异地加密的输入
- [ADR-0003](0003-bare-metal-topology.md)：备份目录与部署边界
- 实现：`apps/api/scripts/backup/online-backup.mjs`（`BACKUP_ENCRYPT_OFFSITE` / `AGE_RECIPIENT` / `AGE_BIN` / `GX_OFFSITE_TARGET`，rc=3 fail-loud）
- 配置：`deploy/env.conf.example`（加密段）
- 手册：`docs/runbooks/backup.md`、`docs/runbooks/restore.md`（identity 离线导入与解密恢复）

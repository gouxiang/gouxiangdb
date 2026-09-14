# wizard/

安装/升级/卸载/配置向导演示目录。

- 最小可用版本：本目录留空，安装时不弹表单；`CORS_ORIGIN` 缺省由
  `cmd/install_callback` 写占位，安装后在 `TRIM_PKGETC/gouxiangdb.env`
  改实际 NAS 访问来源并在应用中心重启。
- 需要"安装时收集外部访问来源"时，按飞牛「配置向导」文档新增 `install`
  向导（字段 `external_origin`，无 TRIM_ 前缀）；install_callback 已读取该变量。

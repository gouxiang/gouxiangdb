# wizard/

安装/配置向导（0.2.5 起，独立端口服务）。

- `install`：安装时收集服务端口，字段 `wizard_port`（默认 3001，纯数字；
  范围 1024-65535 在 `cmd/install_callback` 二次校验）。该值既写入
  `TRIM_PKGETC/gouxiangdb.env` 的 `PORT`，也被 `app/ui/config` 以
  `${wizard_port}` 引用，门户据此跨源 iframe 嵌入 `http://NAS:端口`。
- `config`：应用设置中改端口，提交后由 `cmd/config_callback` 定点回写 env 的
  `PORT`（其它行保留）；如系统未自动重启，在应用中心停止再启动一次生效。
- 字段自定义前缀固定 `wizard_`，禁用系统保留的 `TRIM_` 前缀。
- `upgrade`、`uninstall` 不需要收集输入，不提供（缺省不弹表单）。

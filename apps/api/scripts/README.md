# apps/api/scripts/

迁移与运维脚本目录。所有脚本用 Node.js（>=22）直跑，依赖已在根 `package.json` 里声明。

## migrate-from-v1.mjs — v1 → v2 数据迁移

把 macOS 原生版 GouXiangDB（v1 SQLite）的全部数据迁移到 v2 Web/Hono/Prisma+SQLite 数据库。

### 用法

```bash
# 1) 在 v2 注册一个 owner 账号（首次使用）
node scripts/migrate-from-v1.mjs signup you@example.com YourPwd123 'Your Name'

# 2) 把 token 存到环境变量
export V2_TOKEN='eyJhbGciOiJIUzI1NiIs...'   # 上面 signup 输出的 token

# 3) 执行迁移
node scripts/migrate-from-v1.mjs run --token "$V2_TOKEN"

# 或用 email/password 登录（无需先 signup）
node scripts/migrate-from-v1.mjs run --email you@example.com --password YourPwd123

# 4) 干跑模式：只读 v1 数据并打印迁移计划，不调 v2
node scripts/migrate-from-v1.mjs run --dry-run
```

### 选项

| 选项 | 说明 | 默认值 |
| --- | --- | --- |
| `--db PATH` | v1 数据库路径 | `~/Library/Application Support/GouXiangDB/data.gxdb` |
| `--api URL` | v2 API 地址 | `http://127.0.0.1:3001` |
| `--base-name NAME` | 新建 v2 base 的名称 | `"v1 迁移数据"` |
| `--token` / `--email+--password` | 认证方式 | 二选一，必填 |
| `--dry-run` | 只读不写 | off |

### 转换映射

| v1 字段类型（uidt） | v2 字段类型（type） | 备注 |
| --- | --- | --- |
| SingleLineText / LongText / RichText | 同名 | |
| Number / Currency / Percent / Duration | number | precision 沿用 |
| Date / DateTime | date / datetime | |
| Checkbox | checkbox | |
| SingleSelect / MultiSelect | 同名 | v1 不带 options 元数据，迁后为空 |
| Email / URL / Phone / Rating / AutoNumber / JSON | 同名 | |
| Attachment | attachment | |
| Links | links | relationKind 沿用，relatedTableId 映射到 v2 表 id；反向字段 v2 自动建 |
| Lookup / Rollup / Count | 同名 | linkFieldId/lookupFieldId 映射到 v2 字段 id |
| Formula | formula | 公式字符串原样保留 |
| ID / CreatedTime / LastModifiedTime / CreatedBy / LastModifiedBy | 系统字段 | v2 自动建，跳过 |
| Collaborator / User | — | v2 无对应类型，**跳过并提示** |

视图 vtype 映射：`grid` → `grid`、`gallery` → `gallery`、`kanban` → `kanban`、`timeline` / `list` → `detail`。
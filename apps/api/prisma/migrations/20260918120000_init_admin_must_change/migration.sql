-- 迁移 #24：users 增加 mustChangePassword（首次部署超级管理员强制改密闸门）。
--
-- 用途：部署链路在迁移完成后调用 init-admin 脚本创建首个超级管理员（ACTIVE 用户 + 系统
-- owner 授予），该账号必须被标记 mustChangePassword=true，使其首次登录后只能改密——
-- 除白名单（GET /api/auth/me、POST /api/auth/me/change-password、/api/auth/login、
-- /api/health）外一律 403 PASSWORD_CHANGE_REQUIRED；改密成功后置 false 解除闸门
-- （见 src/middleware/mustChangePassword.ts 与 src/auth.ts change-password）。
--
-- 纪律：
--   1. 只加列，不改既有列、不删数据；NOT NULL + 常量默认 false，不需要回填 UPDATE。
--   2. 存量行默认 false，不影响现有账号（普通注册/邀请账号闸门恒不触发）。
--   3. SQLite 的 ALTER TABLE ADD COLUMN 不能带 REFERENCES，本列是纯 BOOLEAN 标量，
--      无 FK、无需 REFERENCES，也不建索引（只在登录后的解析路径点查 users 单行时顺带取出）。
--   4. 幂等：本迁移由 prisma migrate deploy 按 _prisma_migrations 记录只执行一次；
--      手写 SQL 不做 IF NOT EXISTS（ADD COLUMN 无该语法），重放会报错属预期。

ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

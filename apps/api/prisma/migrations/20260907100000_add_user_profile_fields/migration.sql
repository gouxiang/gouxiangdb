-- 个人中心：扩展 User 表（username 唯一、phone/avatarUrl/bio 可选、updatedAt 自动）
-- SQLite 限制：ALTER TABLE ADD COLUMN 不能给 NOT NULL 配非常量默认值 → updatedAt 先 nullable
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN avatarUrl TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN updatedAt DATETIME;

-- 回填 updatedAt = createdAt（已有数据）
UPDATE users SET updatedAt = createdAt WHERE updatedAt IS NULL;

-- username 唯一索引（SQLite CREATE UNIQUE INDEX 允许多个 NULL）
CREATE UNIQUE INDEX users_username_key ON users(username);

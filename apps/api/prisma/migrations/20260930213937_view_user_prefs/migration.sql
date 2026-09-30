-- 视图每用户使用态覆盖（#561）：每 (viewId,userId) 唯一行，prefs 存 ViewUserPrefs JSON。
-- 删除视图/用户级联清理；无行的用户跟随视图默认配置。
CREATE TABLE "view_user_prefs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "viewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prefs" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "view_user_prefs_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "views" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "view_user_prefs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 每用户每视图仅一行
CREATE UNIQUE INDEX "view_user_prefs_viewId_userId_key" ON "view_user_prefs"("viewId", "userId");

-- 按视图批量加载（列表/删除）
CREATE INDEX "view_user_prefs_viewId_idx" ON "view_user_prefs"("viewId");

-- 视图管理员配置层（#560）：可空 TEXT，存 ViewAdminConfig JSON；null=老视图/未配置。
ALTER TABLE "views" ADD COLUMN "adminConfig" TEXT;

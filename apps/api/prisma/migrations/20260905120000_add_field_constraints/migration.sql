-- AlterTable: 字段约束/默认值补齐（defaultNow、maxLength 曾被前端提交但后端无列，静默丢弃）
ALTER TABLE "fields" ADD COLUMN "maxLength" INTEGER;
ALTER TABLE "fields" ADD COLUMN "defaultNow" BOOLEAN NOT NULL DEFAULT 0;

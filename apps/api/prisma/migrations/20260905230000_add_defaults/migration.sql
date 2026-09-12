-- AlterTable: 字段默认内容配置（defaultConfig）与自动编号规则（numberRule）
ALTER TABLE "fields" ADD COLUMN "defaultConfig" TEXT;
ALTER TABLE "fields" ADD COLUMN "numberRule" TEXT;

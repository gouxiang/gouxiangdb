-- AlterTable: 子表格「选择数据」弹窗可见字段（与内嵌显示字段 displayedFieldIds 独立）
ALTER TABLE "fields" ADD COLUMN "visibleFieldIds" TEXT;

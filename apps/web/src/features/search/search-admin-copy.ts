// M5 检索管理面中性文案（纯映射，无 IO）：错误码 → 用户可读提示，覆盖度 A-F → 可读标签。
// 所有文案面向普通工作区所有者，不出现向量库/嵌入端点/扩展/SQL/表名等实现词。
import type { M5AdminErrorCode, SearchCoverage } from "@gx/shared-types";

/** M5 管理面错误码 → 中性中文提示（不泄露实现，告诉用户下一步怎么做）。 */
export function adminErrorMessage(code: string | null, fallback = "操作失败，请稍后重试"): string {
  switch (code as M5AdminErrorCode | null) {
    case "EMBEDDING_CONFIG_INVALID":
      return "配置不完整或格式有误，请检查服务地址、型号名称与各项数值后重试";
    case "NEED_CLOUD_CONFIRM":
      return "切换到云端语义检索需要先确认数据将发送到外部服务";
    case "REINDEX_IN_PROGRESS":
      return "索引正在重建中，请等待当前任务完成后再试";
    case "SEARCH_UNAVAILABLE":
      return "检索服务当前不可用，已为你保留关键词检索";
    case "REINDEX_FAILED":
      return "重建未能完成，请稍后重试；关键词检索不受影响";
    default:
      return fallback;
  }
}

/** 云端出域确认文案（off->cloud 二次确认弹窗）。 */
export const CLOUD_CONSENT_TEXT =
  "启用云端语义检索后，用于检索的文本内容会发送到你填写的外部服务进行理解与匹配。请确认该服务符合你的数据合规要求。";

/** 覆盖度单项可读标签 + 简短说明（A-F，对应 openapi SearchCoverage）。 */
export interface CoverageLabel {
  key: keyof SearchCoverage;
  label: string;
  hint: string;
  /** 是否阻断级（true=应尽快处理；false=可自愈/警告）。 */
  blocking: boolean;
}

export const COVERAGE_LABELS: readonly CoverageLabel[] = [
  { key: "a", label: "漏索引", hint: "有内容尚未建立检索索引", blocking: true },
  { key: "b", label: "脏行", hint: "索引指向了已删除的内容，将在重建后清理", blocking: true },
  { key: "c", label: "悬空引用", hint: "部分索引引用暂时失效，通常会自动恢复", blocking: false },
  { key: "d", label: "语义索引欠账", hint: "云端模式下部分内容尚未完成语义索引", blocking: false },
  { key: "e", label: "关键词索引缺失", hint: "部分内容缺少关键词索引", blocking: true },
  { key: "f", label: "授权漏登", hint: "部分字段级索引缺少授权登记", blocking: true },
];

/** 积压队列可读标签。 */
export const BACKLOG_LABELS = {
  pending: "等待重建",
  failed: "重建失败",
  dead: "已放弃",
} as const;

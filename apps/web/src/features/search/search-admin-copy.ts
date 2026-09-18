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

/**
 * 检索子面未启用（服务端未开检索开关，admin 端点 404 NOT_FOUND）时的中性文案：
 * 明确"功能没开"而非"稍后重试可恢复"，并讲清关键词检索照常可用。
 */
export const SEARCH_NOT_ENABLED = {
  /** 覆盖度面板空态标题。 */
  title: "语义检索服务未启用（当前为仅关键词检索）",
  /** 覆盖度面板空态正文。 */
  body: "如需使用，请在服务端环境变量中开启检索开关后重启应用。关键词检索不受影响，可照常使用。",
  /** 重建索引按钮禁用原因（title + 旁注共用）。 */
  reindexHint: "语义检索服务未启用，重建索引不可用",
  /** 对未启用的子面发起写操作时的 toast（重建/改配置共用）。 */
  toast: "语义检索服务未启用，无法完成该操作",
} as const;

/**
 * 「如何启用」自助指引：检索子面由服务端环境变量控制，界面天然无法代改（应用也无权改自己的
 * 环境并重启）。与其让用户面对一个点了没反应的表单，不如直接把可执行步骤写出来、片段可复制。
 *
 * 只出现于子面未启用时；文案中性，不出现向量库/扩展/SQL 等实现词。
 */
export const SEARCH_ENABLE_GUIDE = {
  title: "如何启用",
  /** 一句话定位：这是服务端开关，不是界面能开的功能。 */
  intro: "语义检索由应用所在机器的服务端开关控制，需要在环境变量配置文件中开启并重启应用后才能使用。",
  /** 环境变量文件的位置（按部署形态给常见路径，够用户定位用）。 */
  where: [
    "飞牛 fnOS：/vol1/@appconf/gouxiangdb/gouxiangdb.env",
    "Docker：compose 文件里该服务的 environment 段",
    "裸机 / systemd：应用目录下的 .env",
  ],
  /** 可直接复制的配置片段（GX_M5_SEARCH 总门 + 检索方式，cloud 三项按需取消注释）。 */
  snippet: [
    "# 打开统一检索（关键词检索 + 可选语义检索）",
    "GX_M5_SEARCH=on",
    "",
    "# 检索方式：off = 仅关键词，不出网；cloud = 额外启用语义理解",
    "GX_EMBEDDING_MODE=off",
    "",
    "# 若上一行设为 cloud，再补齐这三项",
    "# GX_EMBEDDING_BASE_URL=https://你的语义服务地址/v1",
    "# GX_EMBEDDING_API_KEY=你的密钥",
    "# GX_EMBEDDING_MODEL=你的模型名",
  ].join("\n"),
  /** 收尾步骤。 */
  finish: "保存后重启应用，再回到本页即可看到索引覆盖与健康状态。",
  /** 安抚：关键词检索本来就能用，不受影响。 */
  reassure: "关键词检索无需任何配置，现在就可以正常使用；未启用期间本页的写入操作不可用。",
  copyOk: "配置片段已复制到剪贴板",
  copyFail: "复制失败，请手动选中并复制",
} as const;

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

// packages/shared-types/src/layoutVersion.ts
// 表单设计器布局版本的【信封契约】—— 前后端共用的唯一真源。
//
// 为什么要放在 shared-types 而不是只留在 apps/api：
// 前端要自己构造信封去 POST「回退前保护备份」，也要解析 GET 回来的 snapshot。
// 若类型只在服务端，前端必然复制一份，改结构（尤其 bump SNAPSHOT_ENVELOPE_VERSION）
// 时两份真源就会漂。这里定义，服务端 re-export 复用，前端直接 import。
//
// 服务端实现：apps/api/src/domain/formLayoutSnapshot.ts（构造/解析/归一化）。
//
// 信封结构：
//   {
//     "version": 1,
//     "layout": <DetailLayout 全量 JSON 或 null>,
//     "tabs": { "<tabs 字段 id 或 tab uuid>": {
//         "cards": string[],        // 展平成员：判"在不在容器里"、前端预览/判脏用
//         "lazyTouched": string[],  // 已实际展开过的 tab id（懒加载容器）
//         "tabs"?: TabConfig[]      // 【可选】每个 tab 的完整结构，承载分组/宽度/行边界
//     } }
//   }
// 键序固定（version → layout → tabs，tabs 键升序，TabConfig 内 id→name→fieldIds→widths→rows），
// 因此同一内容序列化的字符串是确定的，可用于判脏。

// DetailLayout 定义在 views.ts、TabConfig 定义在 fields.ts，此处只 import 使用，
// 不再 re-export（index.ts 用 export * 汇总，重复导出同名类型会冲突）。
import type { TabConfig } from "./fields.js";
import type { DetailLayout } from "./views.js";

/** 信封结构版本号：破坏性变更才 +1（旧信封仍要能被服务端 extractSnapshot 读出）。 */
export const SNAPSHOT_ENVELOPE_VERSION = 1;

/** 信封顶层键的固定顺序（服务端按此序构造，保证序列化确定）。 */
export const SNAPSHOT_ORDER_FIELDS = ["version", "layout", "tabs"] as const;

/** 单个选项卡容器（或单个 tab）在快照里的内容。 */
export interface FormLayoutTabSnapshot {
  /** 容器内/该 tab 内的字段 id 有序列表（去重，保持顺序） */
  cards: string[];
  /** 前端已实际展开过的 tab id（懒加载容器用），去重保序 */
  lazyTouched: string[];
  /**
   * 可选：该容器下【每个 tab】的完整结构快照（id/name/fieldIds/widths/rows）。
   *
   * cards 只是展平后的成员集合，回答不了"哪个字段在哪个 tab 里"，也不带宽度占比
   * 与用户显式拆出的行边界 —— 多 tab 容器只靠 cards 回退会丢分组、宽度走默认、分行全丢。
   * 存在时回退以它为准（精确还原）；缺失时退化为按 cards 重建（兼容历史信封）。
   */
  tabs?: TabConfig[];
}

export interface FormLayoutSnapshotEnvelope {
  version: number;
  layout: DetailLayout | null;
  tabs: Record<string, FormLayoutTabSnapshot>;
}

/** 列表接口返回的元数据（不含 snapshot 正文）。 */
export interface FormLayoutVersionMetaDTO {
  id: string;
  viewId: string;
  version: number;
  /** 手动版本标签（如"回退前自动备份"）；null = 自动版本（参与 50 条上限淘汰） */
  label: string | null;
  createdBy: string;
  /** ISO 8601 字符串 */
  createdAt: string;
}

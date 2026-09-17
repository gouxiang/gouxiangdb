// M6/S6 三份语言说明书（**静态常量 markdown**；不落盘、不读文件、不含任何真实业务数据）。
//
// 用途：经 MCP Resources 暴露给 AI 客户端（gx://manuals/table|blocks|canvas），对任何已认证主体可读（不挂 scope 门）。
// 一致性约束（由 m6-s6-manuals.test.ts 守栏）：文中出现的每个工具名都必须真实存在于 TOOL_CATALOG；
// 且 TOOL_CATALOG 中除连接性工具 ping_echo 外的每个工具都至少被某份说明书提到一次，防止说明书与目录漂移。

/** 表与记录语言：表/记录语义 + filter 算子白名单 + keyset 分页 + 配额。 */
export const TABLE_LANGUAGE_MD = `# 表与记录语言

本说明书面向通过 MCP 读写数据表与记录的客户端，说明可用工具、筛选语法与配额约束。

## 工具
- table.list_bases：列出当前令牌可见的基础库 id 与名称。无入参。
- table.get_schema：读取某基础库下可见的表与可见字段；不可见字段不会出现在结果中。入参 baseId。
- record.list_records：按 keyset 游标分页读取表内记录。入参 tableId、cursor、limit、search。
- record.query_records：带受控 filter 与 sort 的 keyset 查询。入参 tableId、filter、sortFieldId、sortDirection、cursor、limit。
- record.create_record：创建一条记录，需 confirm=true。入参 tableId、fields、confirm。
- record.update_record：更新一条记录的字段。入参 tableId、recordId、fields。
- record.delete_record：软删除一条记录，需 confirm=true。入参 tableId、recordId、confirm。
- record.search：统一关键词与向量检索。入参 q、mode（auto 或 fts 或 vector）、limit。

## 记录与字段语义
- 记录以 recordId 标识；字段值以 fieldId 到 value 的映射表示。
- 字段类型由表结构决定；写入前建议先用 table.get_schema 读取字段 id 与类型，避免类型不符被拒。

## filter 算子白名单
filter 为数组，每项形如含 fieldId、op、value 的对象。op 仅允许以下取值：
is、isNot、contains、notContains、isEmpty、isNotEmpty、gte、lte、gt、lt、isAnyOf、checked、notChecked。
不允许任意 SQL 或公式表达式；越界算子会被入参校验直接拒绝。

## 分页
- 列表类读取统一使用 keyset 游标：响应给出 nextCursor 与 hasMore。
- 翻页时把上一页返回的 nextCursor 原样回传，不要自行拼装游标。

## 配额
- 读类 limit 上限 200，超过由入参校验直接拒绝。
- 写类批量上限 100。
`;

/** 文档块语言：块类型全集 + append_blocks 的 op 结构 + 乐观锁 + align 通道 + 上限。 */
export const BLOCK_LANGUAGE_MD = `# 文档块语言

本说明书说明文档正文的块模型。文档正文以 Markdown 存储；服务端在 Markdown 与结构化块之间双向转换，
读取与写入共用同一套转换规则。

## 工具
- doc.get_doc_blocks：读取文档块（format=blocks）或原始 Markdown（format=markdown）；range 按块序号以 0 起始的闭区间切片。
- doc.append_blocks：在指定块之后（缺省为末尾）追加若干块。
- doc.update_block：更新单个块的 text 或 checked 或 align。
- doc.delete_blocks：原子批删若干块，需 confirm=true。

## 块类型全集
p、h1、h2、h3、h4、h5、h6、ul、ol、task、quote、callout、toggle、code、hr、pagebreak、table、image、video、audio、pdf、attachment、math、raw。
其中 raw 为无法结构化的内容，原样透传，不会丢内容。

## append_blocks 的 op 结构
每个 op 由 type 加该类型的属性组成，**不携带 id**：块 id 一律由服务端生成，客户端不得自带或覆盖块 id。
- type：上述块类型之一（必填）。
- 文本类块（p、h1 至 h6、ul、ol、quote、callout、toggle、task）：text 为行内 Markdown。
- task：checked 为布尔。
- code：lang 与 code。math：formula。table：rows 为二维字符串数组，第 0 行为表头。
- 媒体类（image、video、audio、pdf、attachment）：src、alt、name。
- align：left 或 center 或 right，仅对文本类块生效。

## 块标识与内容版本
- doc.get_doc_blocks 返回的每个块带 seq 与位置派生的 id，供 afterBlockId、blockId、blockIds 使用。
- 该标识在**同一内容版本内**稳定；任何写入都会递增内容版本，跨版本请重新读取后再操作。

## 乐观锁 baseVersion 与冲突处置
- 写入可携带 baseVersion（读取时得到的内容版本）。命中则条件更新；不匹配返回 VERSION_CONFLICT 并附 currentVersion。
- 未携带 baseVersion 时按后写覆盖处理（与 REST 同口径），内容版本照常递增。
- 收到 VERSION_CONFLICT 后，应重新调用 doc.get_doc_blocks 取得最新内容与块标识，再重放本次变更。

## align 通道
- align 只通过块级对齐注释持久化，由服务端序列化；客户端不要手写对齐标记，直接写 align 字段即可。

## 配额与上限
- 单次 ops 或 blockIds 上限 100。
- 单批文本上限 100KB（UTF-8 字节，服务端实测）。
- 文档正文上限 10MB。
`;

/** 画布图元语言：元素结构 + 当前支持的写入最小集 + 二期操作声明。 */
export const CANVAS_LANGUAGE_MD = `# 画布图元语言

本说明书说明画布正文的元素结构，以及当前经 MCP 支持的写入最小集。

## 工具
- canvas.get_board：只读读取画布元素与内容版本。入参 docId。

## 元素结构
- 画布正文是一段 JSON，顶层为元素数组（不是包含 children 的对象）。
- 每个元素至少含 type 与 points；几何图元另含 shape。
- 元素可携带自定义键（注释、关联引用等）；读取时原样返回，不会被裁剪或剥离。

## 当前支持的写入最小集
- element.create：仅支持几何矩形，即 type 为 geometry 且 shape 为 rectangle。
- 该最小集只允许在元素数组尾部追加自足图元，且元素 id 由服务端生成。

## 二期操作（当前不支持，调用将明确报错，不会静默成功）
- 更新、移动、缩放、删除、连线、层级调整、思维导图布局等操作。
- 连线（箭头）图元依赖两端绑定到既有节点，属于绑定关系而非自足图元，故不纳入最小集。

## 只读现状
- 当前画布能力为只读（canvas.get_board）；写入能力随二期操作集一并开放。
`;

/** 说明书资源规格（不含 URI 之外的业务数据）；由 server.ts 注册为 MCP Resources。 */
export interface ManualSpec {
  /** 资源展示名。 */
  name: string;
  /** 资源 URI（gx://manuals/<lang>）。 */
  uri: string;
  mimeType: string;
  /** 说明书正文（静态常量）。 */
  text: string;
}

export const MANUAL_RESOURCES: readonly ManualSpec[] = [
  { name: "表与记录语言", uri: "gx://manuals/table", mimeType: "text/markdown", text: TABLE_LANGUAGE_MD },
  { name: "文档块语言", uri: "gx://manuals/blocks", mimeType: "text/markdown", text: BLOCK_LANGUAGE_MD },
  { name: "画布图元语言", uri: "gx://manuals/canvas", mimeType: "text/markdown", text: CANVAS_LANGUAGE_MD },
];

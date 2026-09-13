# Spike：WorkBuddy 开放接入能力评估（需求6）

- 调研人：research-workbuddy
- 日期：2026-09-12
- 调研性质：只调研、出报告，不写项目代码
- 调研对象：WorkBuddy（腾讯全场景 AI 办公工作台，workbuddy.cn；开放平台 open.workbuddy.cn，2026-09-02 正式上线）
- 判定口径：【官方明确】有官方文档原文依据；【文档未提及】官方公开文档查不到、不下定论；【明确不支持/受限】官方写明限制或与要求冲突。第三方/社区资料一律标注为"旁证"，不作为事实结论。

---

## 一、结论先行（三态判定）

| 调研问题 | 判定 | 一句话结论 |
|---|---|---|
| 1. 是否支持第三方插件化接入 | 【官方明确：支持】 | 有正式"开放平台"，提供连接器（MCP/CLI）、技能 Skill、专家/专家团、Buddy 应用、外部应用接入（Open API）等多条通道。**GouXiangDB 走标准 MCP 连接器即可接入，这是官方推荐路径。** |
| 2. 能否保留 GouXiangDB 完整能力 | 【官方明确：基本可以，有两个工程约束】 | 标准 MCP 工具全集可暴露，AI 在 WorkBuddy 对话中可调用；约束是"一个连接器只能配一个 MCP Server"（用一个 server 暴露全部工具即可规避），以及工具需在 schema/Skill 中清晰描述、单次请求建议 30s 内返回。无"工具数量/能力裁剪"的官方限制。 |
| 3. 能否保留自带聊天框/对话 UI | 【官方明确：能，且无需另建前端】 | WorkBuddy 本身就是带对话区+结果区的 Agent 桌面工作台，用户在其对话框里用自然语言调用连接器暴露的 MCP 工具；Buddy 应用还支持 iframe / MCP Apps 内嵌现有系统界面。客户端为桌面端为主（另有小程序/手机远控、企业微信/微信下发指令），**不是浏览器网页 SaaS 形态为主**。 |
| 4. 鉴权能否按 GouXiangDB 账号体系隔离 | 【官方明确：机制齐备，能否"自动透传登录态"需进一步验证】 | 远程 MCP 支持三种鉴权：Server 自带 OAuth（WorkBuddy 内置 OAuth 2.1 + PKCE 客户端）、云端托管（server-side/gateway）、用户自填 Token（Personal Access Token/API Key + 可填私有 Base URL，凭证仅存本机、以自定义 header 注入）。**"AI 只能按所属账号权限操作"必须由 GouXiangDB 的 MCP Server 服务端强校验**，WorkBuddy 负责传递身份凭证，不替你做授权。是否支持"免填、自动透传当前 WorkBuddy 登录身份"属【文档未提及】，标准 MCP 接入下最稳的是 OAuth 或每用户 PAT。 |
| 5. 内网/私有化部署可行性 | 【官方明确：有私有化产品线；标准版即可连内网地址，但"数据不出内网"需企业私有化版】 | token 模式的 `API_BASE_URL` 官方示例明确"私有部署可改为内网地址"；stdio 模式天然本机/内网。但标准 SaaS 版的模型推理在腾讯云端，工具调用结果会进入云端上下文，**不满足严格"数据不出内网"**。要彻底内网闭环需 WorkBuddy Enterprise 的"专享版（VPC 专属网络）"或"企业私有化版（企业内网、自备算力与模型、数据不出域，300 席起）"。 |

**底线结论**：GouXiangDB 规划中的"标准 MCP Server + 鉴权"与 WorkBuddy 的官方推荐接入方式（MCP + Skill 连接器）天然吻合，**无需为 WorkBuddy 做专属定制**，同一套 MCP Server 可同时服务 Claude Desktop / Cursor 等任意标准 MCP 客户端。最大的不确定性不在"能不能接"，而在两点：(a) 严格内网数据不出域需采购高额企业私有化版；(b) 多租户下"当前用户身份自动透传"建议用 OAuth 2.1 或每用户 PAT，且权限必须在 GouXiangDB 服务端二次校验。

---

## 二、WorkBuddy 集成形态能力矩阵

官方开放平台文档（open.workbuddy.cn/docs）明确的开发者资产类型：

| 集成形态 | 是否支持 | 能做什么 / 与 GouXiangDB 的关系 | 文档依据 |
|---|---|---|---|
| 连接器 Connector —— MCP + Skill（推荐） | 【官方明确】 | 基于标准 MCP 协议把工具暴露给 WorkBuddy 内 AI；远程用 HTTPS 的 SSE 或 streamableHttp，本地进程用 stdio。**这是 GouXiangDB 的主路径。** | https://open.workbuddy.cn/docs/connector |
| 连接器 Connector —— CLI + Skill | 【官方明确】 | 已有跨平台命令行工具时，由 WorkBuddy 安装/调度 CLI，CLI 自管凭证。GouXiangDB 不适用（我们是 HTTP 服务）。 | 同上 |
| 技能 Skill | 【官方明确】 | Markdown 指令包（SKILL.md + references/scripts/templates），教 AI"何时、怎么用工具、高风险操作确认规则"。连接器可附带 Skill 提升工具选择准确率，**建议随连接器提供**。 | https://open.workbuddy.cn/docs/connector（"Skill 文件"节） |
| 专家 Expert / 专家团 Expert Team | 【官方明确】 | 可安装的专业 Agent 角色（plugin.json + agents）。可做一个"勾箱数据库助手"专家，绑定我们的连接器；非接入必需。 | 开放平台概述 https://open.workbuddy.cn/docs |
| Buddy 应用 | 【官方明确】 | 企业/行业定制工作台，在同一客户端内切换专属工作空间；**支持 iframe / MCP Apps 内嵌现有系统**、定制工作模式/模型/市场。适合把 GouXiangDB 整体包装成行业工作台，但属较重合作形态（灰度/内测，可能需商务对接）。 | https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Buddy-App |
| 外部应用接入（Open API，反向） | 【官方明确】 | 第三方系统以应用身份经 OAuth 2.1 授权码调用 WorkBuddy 的 Open API（读写用户任务、驱动本地助理等）。方向相反，是"GouXiangDB 去调 WorkBuddy"，不是我们要的"WorkBuddy 调 GouXiangDB"。access_token 24h、refresh_token 60d。 | 开放平台概述 https://open.workbuddy.cn/docs |
| 用户自助配置自定义 MCP（不走市场审核） | 【官方明确，旁证较强】 | 编辑 `~/.workbuddy/mcp.json`（用户级）或 `<项目>/.workbuddy/mcp.json`（项目级），填 command/args/env（stdio）或 url/headers（HTTP），在连接器管理里"信任"后启用。**团队 PoC/内部试点可直接用，无需上架审核。** | 官方帮助文档与多篇教程旁证；配置格式与 open.workbuddy.cn 连接器文档一致 |
| 插件市场分发 | 【官方明确】 | 连接器打包（connector-meta.json + mcp.json + icon.svg + skills/）提交审核，通过后进连接器市场，10~15 分钟同步生效。需个人/企业实名认证。 | https://open.workbuddy.cn/docs/connector（"提交前检查"） |
| iframe / webview 嵌入 GouXiangDB 界面 | 【官方明确，限于 Buddy 应用】 | Buddy 应用配置支持"内嵌已有功能（iframe / MCP Apps）"。普通连接器只暴露工具，不带自定义 UI（工具结果在 WorkBuddy 结果区渲染）。 | 同上 Buddy-App 文档；第三方教程旁证 |

> 说明：开放平台"概述"页官方列出 技能 / 专家 / 专家团 / 连接器 / 外部应用接入 五类；官网定价与百度百科口径另有"Buddy 应用""硬件"，合计有"六类生态能力"的说法。Buddy 应用文档在 workbuddy.cn 主文档站可查，属真实能力，但开放平台面向第三方自助上架的成熟度可能仍在灰度——此条按【官方明确其存在，自助开放程度待与官方确认】对待。

---

## 三、能力保留评估（能不能把 MCP 工具全集交给 WorkBuddy 里的 AI）

【官方明确】的协议事实：

- 连接器底层就是标准 MCP（Model Context Protocol，Anthropic 2024 年开源的开放协议）。官方要求"遵循 MCP 稳定协议版本"，并直接链到 modelcontextprotocol.io 及官方 Python/TypeScript SDK。**含义：任何符合标准 MCP 的 server，WorkBuddy 都能连；我们不承担私有协议适配成本。**
- MCP 的 Tools / Resources / Prompts 三类原语都走标准协议；GouXiangDB 规划的数据表/文档/画布工具以 Tools 暴露即可，结构化数据可读能力可用 Resources。
- 官方对工具的要求是"名称、描述、参数、返回值清晰稳定，便于 AI 正确选择和调用""返回可读错误、单次请求建议 30 秒内响应、可用性建议 99.9%"——这是质量约束，不是能力裁剪。

需要注意的工程约束（均为【官方明确】）：

1. **一个连接器只配置一个 MCP Server**。对策：在单个 MCP Server 内暴露全部工具（可用命名空间/前缀分组，如 `table.*`、`doc.*`、`canvas.*`），不要拆成多 server。
2. **工具数量没有官方上限**，但工具过多会稀释模型选择准确率。官方建议第一版只暴露最小工具集，复杂业务用 Skill 补充"何时用哪个工具、高风险确认、参数选择、错误恢复"。`disabledTools`（WorkBuddy ≥ 4.22.15）可对特定分发隐藏高危工具（如 delete/drop）。
3. **长任务**：官方建议耗时操作返回任务 ID 再轮询，写操作做幂等。GouXiangDB 的大批量导入/复杂画布操作应按此设计。
4. 富 UI：普通 MCP 工具返回的是文本/结构化结果，在 WorkBuddy 结果区展示。若要保留 GouXiangDB 的可视化表格/画布交互界面，纯连接器做不到"在对话里内嵌可操作的完整前端"，需要 Buddy 应用的 iframe/MCP Apps，或仍由独立 GouXiangDB 客户端/网页承担编辑界面、WorkBuddy 只承担"对话驱动操作"。

> 事实与推断分界：以上 1/2/3 为文档原文；"工具过多影响准确率"是官方在认证/最佳实践段落表达的倾向性建议。

---

## 四、聊天框 / 对话 UI 与客户端形态

【官方明确】：

- WorkBuddy 客户端本身就是对话式 Agent 工作台，界面分三区：左侧任务列表、中间**对话区**（任务标题+消息流+输入框，支持上传文件、持续追问）、右侧结果区（产物/文件/变更/预览）。用户安装连接器后，**直接在 WorkBuddy 对话框用自然语言即可调用 GouXiangDB 工具，无需我们另建聊天前端**。
- 客户端形态：以**桌面工作台**为核心（macOS/Windows，文档中配置路径、stdio、本地文件操作均以桌面端为准）；另有手机端远程连接、小程序端体验，可通过微信/企业微信下发指令（官网与客户证言）。**主文档未把"纯浏览器网页版"作为主要形态**——它是本地优先的桌面 Agent，这点与典型 SaaS 不同。
- Buddy 应用：在同一客户端内切换到企业定制工作空间，含专属品牌、工作模式、场景胶囊、专属专家/技能/连接器，并可 iframe / MCP Apps 内嵌现有系统。进入时走绑定账号 + 第三方授权页（"授权 WorkBuddy 访问该应用的 MCP 服务"）。

【文档未提及】：是否存在面向最终用户的完整 Web 网页对话端（open.workbuddy.cn 是开发者后台，不是使用端）。对 GouXiangDB 的影响：若目标用户能安装桌面端，则对话 UI 由 WorkBuddy 兜底；若要求"只用浏览器、不装客户端"，则不宜把对话体验完全押在 WorkBuddy，应保留自建 Web 面板（见替代方案 B）。

---

## 五、鉴权衔接（硬安全要求：AI 只能按所属账号在 GouXiangDB 权限内操作）

### 5.1 WorkBuddy 官方支持的四种鉴权形态（open.workbuddy.cn/docs/connector「认证与凭证」）

| 模式 | auth_mode | 是否开浏览器 | 凭证落点 / 传递方式 | 适用 GouXiangDB |
|---|---|---|---|---|
| MCP Server 自带 OAuth 或免鉴权 | 省略 | 需要授权时打开 | WorkBuddy 内置 OAuth 管理器，**OAuth 2.1 + PKCE、公共客户端（无 client_secret）**，自动完成动态注册/授权/换码/续期；调用时带 `Authorization: Bearer <access_token>` | **多租户、要按用户身份隔离时的首选** |
| 云端托管 OAuth | `server-side` / `gateway` | 打开 | 需接入前与 WorkBuddy 团队确认 | 暂不适用（需商务对接） |
| 用户自填 Token | `token`（≥4.23.0） | 不打开 | 弹窗收 Access Token/API Key/**可填私有部署 Base URL**；**凭证仅存用户本机 `~/.workbuddy/`，不经云端**；stdio 注入 env，HTTP 注入 header（如 `Authorization: Bearer ${API_KEY}`）或 url | **团队 PoC / 内网试点最快落地**，每用户一个 PAT |
| CLI 登录 | — | 取决于 CLI | CLI 自管凭证 | 不适用 |

OAuth 2.1 服务端需实现的端点（官方明确）：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/oauth/register`（RFC 7591 动态注册，须接受公共客户端并回显 redirect_uris）、`/oauth/authorize`（须支持 S256 PKCE）、`/oauth/token`（须支持 refresh_token）。回调支持私有协议 `workbuddy://...oauth/callback`，并回退本机回环 `http://127.0.0.1:<port>/oauth/callback`；建议 access_token 1h、refresh_token ≥30d，全端点强制 HTTPS。

### 5.2 能否满足"按账号权限隔离"——关键判断

- 【官方明确】WorkBuddy 把**每用户**的凭证（OAuth token 或本机自填 PAT）放到对 MCP Server 的请求头里。因此 GouXiangDB MCP Server 每次调用都能拿到"是哪个用户"。
- 【必须在 GouXiangDB 侧落实，非 WorkBuddy 能力】真正的"AI 只能在该账号权限内操作"要靠我们的 MCP Server 对每个工具调用做服务端鉴权：解析 token → 定位用户/组织 → 在表/文档/画布的 RBAC/资源归属上二次校验枚举、权限、资源归属，越权直接拒绝。官方安全红线也明确："模型可能选错工具、填错参数、被 Prompt Injection 诱导，服务端必须重新校验；'模型已确认'不等于'真实用户授权'；删除/付款/发布类操作加人工审批。"
- 【官方明确】支持自定义 header（`headers` 内任意键，值用 `${VAR}` 占位），因此可传 `Authorization`、也可传自建的 `X-Org-Id`/`X-Actor-Id` 等（自填 token 模式下可做成表单字段）。
- 【文档未提及】WorkBuddy 是否能在连接器里"自动把当前登录的 WorkBuddy 用户身份（无需用户再授权/填 token）透传"给第三方 MCP Server。标准 MCP+OAuth 下首次仍需用户授权一次；要 SSO 无感，需对接企业 SSO + 云端托管（server-side/gateway，需商务对接）或外部应用接入那条线。**此点建议在 PoC 后向开放平台团队（openworkbuddy@tencent.com / 开发者社群）确认。**
- 官方安全红线（与我们要求一致）：禁止在 connector-meta/mcp.json/Skill/示例中硬编码真实凭证，一律 `${VAR}` 注入；最小权限；远程必须 HTTPS；凭证字段用 password 类型、日志脱敏；失效返回可识别错误并引导重连。

**小结**：鉴权"传递通道"官方齐备且能做到每用户独立凭证；"授权决策"必须且只能由 GouXiangDB 服务端承担。推荐生产用 OAuth 2.1+PKCE（对接我们已有账号体系），试点用每用户 PAT。

---

## 六、内网 / 私有化部署可行性

分两层看，避免混淆：

### 6.1 MCP Server 放在内网 —— 标准版即可触达（【官方明确】+ 旁证）

- 用户自填 Token 模式的 `token-schema.json` 官方示例里，`API_BASE_URL` 字段描述原文："**私有部署可改为内网地址**"。即远程 MCP 的 URL 可以指向企业内网地址（前提是运行 WorkBuddy 桌面端的机器能访问该内网，例如在办公网/VPN/VPC 内）。
- stdio 模式下 MCP Server 作为本机子进程运行，数据天然不出本机，最易满足"本地/内网"。
- 另有"项目级 `.workbuddy/mcp.json`"做项目隔离、用户级做全局复用。

### 6.2 但"模型推理/上下文数据是否出内网" —— 标准版不满足严格要求

- WorkBuddy 是云端模型服务（Quickstart 环境要求："需要网络连接以调用 AI 模型服务"）。即便 MCP Server 在内网，工具返回的数据会作为上下文发到腾讯云端模型。**若合规定义是"任何业务数据不得离开内网/本机"，标准 SaaS 版不达标。**
- 真正内网闭环需 WorkBuddy Enterprise（腾讯云产品页【官方明确】）三档：
  - **旗舰版**：共享网络、多租户逻辑隔离，1 席起。不满足数据不出域。
  - **专享版**：单租户专属资源池、**专属网络 VPC 访问 / Private Link、专属企业插件、专属服务实例、数据租户隔离**，100 席起。
  - **企业私有化版**：部署在**企业内网、自备算力与模型服务、全栈自主可控、数据不出域**，300 席起（面向金融/政企/信创）。
  - 依据：https://cloud.tencent.com.cn/product/workbuddy-enterprise ；安全架构 FAQ https://cloud.tencent.com/document/product/1831/134405
- 私有化版另含：SSO 单点登录、组织架构同步、IP 白名单、精细化工具调用权限、Skill 安全审计/本地扫描、安全通信网关（Gateway Token + 连接鉴权 + RBAC）、OpenAPI 开放等——与我们的按账号鉴权、内网要求方向一致。

【文档未提及 / 需商务确认】私有化版能否在"完全离线、无任何腾讯云依赖"下运行（模型自备可离线，但授权/许可证/更新是否需联网未公开写明）；私有化版的报价与对"第三方自建连接器"的具体管控方式。

---

## 七、替代方案对比

若不把鸡蛋放在 WorkBuddy 一个篮子（尤其为规避"私有化版 300 席起、成本高"和"桌面端依赖"），对四项硬要求逐条比较：

| 方案 | 内网私有部署 | 保留 GouXiangDB 完整能力 | 自带对话 UI | 按账号鉴权 | 成本 / 落地难度 | 说明 |
|---|---|---|---|---|---|---|
| **A. 标准 MCP Server + 通用 MCP 客户端**（Claude Desktop、Cursor、CodeBuddy 等） | 中：取决于客户端；stdio 本机最稳，HTTP 可指内网；但云端模型客户端的数据同样会出内网 | 高：标准 MCP 工具全集，无平台裁剪 | 中：各客户端自带聊天框（Claude Desktop/Cursor 都有），但 UI/体验不统一、非面向终端业务用户 | 高：MCP 同样支持 header/env 传 token，鉴权在我方服务端 | 低：一次开发，处处复用；无审核、无席位费（模型费另算） | **与 WorkBuddy 连接器是同一套 MCP Server，零冲突，建议作为底座必做**。面向开发者/技术用户体验好，面向普通职场人弱于 WorkBuddy。 |
| **B. GouXiangDB 自建 Web 对话面板**（前端接 LLM + 调我们自己的 MCP 工具，ReAct/function-calling） | 高：面板、MCP Server、模型网关全部可部署在企业内网，模型可接内网 VLLM/Ollama/专有模型，**真正数据不出域** | 高：工具、UI、确认交互完全自控，可内嵌我们自己的表格/画布 | 高：对话面板与原应用一体，浏览器即用、不装客户端 | 高：直接复用 GouXiangDB 登录态/session，天然按账号鉴权，无需 OAuth 二次授权 | 中：需自研对话编排、流式渲染、工具确认 UI；但技术栈（React+Hono）现成 | **自控度与合规性最高，是"数据不出内网 + 浏览器使用 + 自带 UI"唯一全绿方案。** 也是 WorkBuddy 私有化版之外的低成本替代。 |
| **C. iframe / SDK 嵌入对话**（把第三方 AI 聊天框 iframe 进 GouXiangDB，或把 GouXiangDB iframe 进 WorkBuddy Buddy 应用） | 低-中：取决于被嵌方是否支持内网；嵌 WorkBuddy 仍受其部署形态约束 | 中：iframe 只能嵌"已有网页系统"，深度工具调用仍靠 MCP/API，不是万能胶 | 中：能快速有框，但跨域、鉴权打通、样式一致性有坑 | 中：需解决跨 frame 的身份传递（postMessage/短期 token），易留安全缝 | 低-中：上线快，长期维护别扭 | 适合 Demo/过渡。Buddy 应用内嵌 GouXiangDB（iframe/MCP Apps）是"借 WorkBuddy 壳"的正规做法，但依赖其灰度与商务。 |
| **（参照）WorkBuddy MCP 连接器** | 中（SaaS）/ 高（企业私有化版） | 高 | 高（桌面端对话区，体验成熟、面向非技术用户最佳） | 高（OAuth/PAT 传身份，我方服务端授权） | 低（技术接入）/ 高（私有化版席位门槛） | 面向腾讯办公生态/普通员工的分发与体验最好；严格内网合规靠高价私有化版。 |

**四要求满足度小结**：
- 只看"技术接入 + 对话体验 + 面向普通用户分发"：WorkBuddy 连接器最省心。
- 只看"严格内网、数据不出域、浏览器使用、零席位成本"：方案 B 自建 Web 面板最稳。
- A 是两者共同的技术底座，投入产出最高，应无条件先做。

---

## 八、给架构师的集成建议与风险

### 建议路线（务实排序）

1. **先把 MCP Server 做成"协议无关"的标准件（必做）**：单一 MCP Server（streamableHttp/SSE over HTTPS，兼容 stdio）暴露 GouXiangDB 数据表/文档/画布工具全集，工具按 `table.* / doc.* / canvas.*` 前缀分组；每个工具都有清晰 JSON Schema、可读错误码、30s 内响应、写操作幂等。这一套同时支撑 WorkBuddy、Claude Desktop、Cursor 和自建面板，不绑定任何平台。
2. **鉴权在 MCP Server 边界强制落地（最高优先，安全红线）**：
   - 每个调用从 `Authorization: Bearer` 解析用户/组织；服务端对资源归属 + RBAC 重新鉴权，不信任模型传入的对象级参数。
   - 高危写操作（删表、删文档、批量改、分享/发布）在工具层要求显式确认 + 幂等键；可在 WorkBuddy 侧用 `disabledTools`（≥4.22.15）对受控分发隐藏高危工具。
   - 防 Prompt Injection：把 MCP 返回内容当不可信数据，不允许其中文本诱导提权；枚举/范围在服务端校验。
3. **接入 WorkBuddy 分两步走**：
   - 试点：用 `~/.workbuddy/mcp.json`（或项目级）自助配置 + 每用户 PAT（`auth_mode: token`，含内网 `API_BASE_URL`，≥4.23.0），不上架、不审核，当天可验证连通与权限隔离。
   - 正式：打包连接器（connector-meta.json + mcp.json + icon.svg）并**随附 Skill**（写清工具用途、参数、确认规则、错误恢复），经实名认证提交连接器市场；若要无感 SSO/多租户自动透传身份，再实现服务端 OAuth 2.1 + PKCE 端点。
4. **内网合规单独立项决策**：标准 SaaS 版仅适合"数据可入云上下文"的团队；客户若硬性要求"数据不出内网"，要么采购 WorkBuddy 企业私有化版（评估 300 席门槛与成本、离线可用性需商务确认），要么走方案 B 自建内网 Web 对话面板（接内网模型）。**不要默认 SaaS 版能满足私有化要求。**
5. **UI 分工预期对齐**：WorkBuddy 承担"自然语言对话 + 结果展示 + 任务编排"，GouXiangDB 原有桌面/Web 端继续承担重度可视化编辑（表格/画布）。想要在 WorkBuddy 内直接操作可视化界面，再评估 Buddy 应用的 iframe/MCP Apps（依赖灰度与商务，不作为一期依赖）。

### 主要风险清单

| 风险 | 等级 | 说明 / 缓解 |
|---|---|---|
| 严格内网数据不出域与 SaaS 版冲突 | 高 | 工具结果进入腾讯云模型上下文。缓解：私有化版 or 自建内网面板（方案 B）；向客户讲清两条部署路径。 |
| "自动透传 WorkBuddy 登录身份"未在公开文档确认 | 中 | 可能仍需每用户授权/填 token。缓解：PAT 先行，OAuth 2.1 做生产 SSO；关键问题找开放平台团队书面确认。 |
| 模型误调/越权/Prompt 注入 | 高 | 缓解：服务端强制鉴权与参数校验、高危操作人工确认、最小工具集、disabledTools。 |
| 平台与版本字段快速演进 | 中 | 连接器多个字段有最低版本要求（auth_mode token ≥4.23.0、disabledTools ≥4.22.15、runtime/staticEnv ≥5.0.0）；需声明 minWorkbuddyVersion 并在目标客户端版本复测。开放平台 2026-09 才上线，审核/分发规则可能调整。 |
| 一个连接器一个 MCP Server | 低 | 单 Server + 工具前缀分组即可。 |
| 桌面端依赖、无成熟纯 Web 使用端 | 中 | 若客户只能用浏览器，以方案 B 兜底。 |
| Buddy 应用/iframe 自助开放度不确定 | 低-中 | 处于灰度/内测、或需商务对接；一期不依赖它。 |
| 厂商绑定 | 中 | 坚持标准 MCP，所有工具逻辑在我方 Server，客户端可整体替换为 Claude/Cursor/自建面板，规避锁定。 |

### 待向官方确认的开放问题
1. 连接器是否支持"自动透传当前 WorkBuddy 登录用户身份"（免二次 OAuth/免填 token）以对接企业 SSO？
2. 企业私有化版是否支持完全离线运行（授权许可、模型、更新是否需联网）？对"客户自建第三方连接器"如何管控与分发？
3. Buddy 应用对第三方自助开放的具体门槛，以及 iframe/MCP Apps 内嵌第三方系统的鉴权打通方式。
4. 单连接器工具数量上限、长连接/SSE 并发与限流策略的官方量化值。
- 联系入口：openworkbuddy@tencent.com；开放平台 https://open.workbuddy.cn/docs ；产品矩阵 https://cloud.tencent.com.cn/product/workbuddy-enterprise

---

## 附：关键官方文档链接

- WorkBuddy 简介/快速开始（客户端形态、三区界面）：https://www.workbuddy.cn/docs/workbuddy/Overview ，/Quickstart ，/Conversation
- Buddy 应用（企业定制工作台、iframe/MCP Apps、绑定与第三方授权）：https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Buddy-App
- 开放平台概述（技能/专家/专家团/连接器/外部应用接入、入驻流程）：https://open.workbuddy.cn/docs
- 连接器官方开发文档（MCP+Skill / CLI+Skill、mcp.json、OAuth、自填 Token、版本兼容、提交审核）：https://open.workbuddy.cn/docs/connector
- WorkBuddy Enterprise 版本与私有化（旗舰/专享 VPC/企业私有化版、席位门槛、数据不出域）：https://cloud.tencent.com.cn/product/workbuddy-enterprise
- 企业安全架构 FAQ（SSO、IP 白名单、Gateway Token、VPC 隔离、数据本地执行）：https://cloud.tencent.com/document/product/1831/134405
- MCP 协议官方站：https://modelcontextprotocol.io/

> 旁证（非官方一手，用于交叉验证 `~/.workbuddy/mcp.json` 自助配置、连接器上线时间 2026-04-29、开放平台 2026-09-02 上线等）：腾讯云开发者社区、ima.qq.com 收藏的多篇 WorkBuddy 教程、百度百科"Buddy应用"词条。配置格式与官方连接器文档一致，但具体自助配置路径请以客户端实际版本为准。

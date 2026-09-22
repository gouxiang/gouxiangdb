# 协同接线前 DOM 基线（pre-wire）

## 这个目录是干什么的

产品红线：给产品加多人实时协同时，**界面和操作一个像素都不许变**。

为了把这句话变成机器能判的东西，判据定为：

> **单机模式（不建立任何协同连接）下，页面 DOM 必须逐元素一致。**

本目录存的就是「接线之前」的基线快照。等协同接线完成后，在**同一台机器、同一账号、同一操作序列**下再跑一次同一套脚本，逐元素比对；有差异就说明界面被动了。

被测站点：`http://192.168.31.167/`（nginx:80，部署版本 v0.1.7，即协同接线前的代码）。
浏览器在本机跑，**不需要** ssh 到 167，也不需要在本机起前后端服务。

## 目录结构

```
baseline/
├── README.md                      ← 本文件
└── pre-wire/                      ← 「接线前」基线快照
    ├── manifest.json              ← 元信息：站点、时间、视口、鉴权来源、种子 ID、每页节点数
    ├── seed-ids.json              ← 本次基线依赖的种子对象 ID（文档/画布/表格行）
    ├── doc/
    │   ├── dom.json               ← 去噪后的 DOM 结构指纹（361 个元素）
    │   └── screenshot.png         ← 1440×900 视口截图
    ├── canvas/
    │   ├── dom.json               ← 374 个元素
    │   └── screenshot.png
    └── grid/
        ├── dom.json               ← 595 个元素
        └── screenshot.png
```

`dom.json` 的形态（每个元素一条记录，`d`=深度，`c`=归一化 class，`a`=归一化属性，`x`=直接文本）：

```json
{"url":"/kb/cmuazmt0t000sed30azpsdcol/canvas/cmubetwfv001ged3056kmbh88",
 "title":"构想工作台","nodeCount":374,"nodes":[
  {"t":"html","d":0,"a":{"lang":"zh-CN"}},
  {"t":"div","d":3,"c":"bg-gx-bg flex flex-col h-screen"},
  {"t":"button","d":5,"c":"flex gap-1.5 ...","a":{"type":"button","aria-label":"保存"},"x":"保存"}
]}
```

## 怎么跑

脚本：`apps/web/scripts/dom-snapshot.mjs`（Playwright 已在 `apps/web` 的 devDependencies 里，**无需新装依赖**）。

```bash
# 1) 取基线（写产物）
node apps/web/scripts/dom-snapshot.mjs --out docs/design/2026-09-collab/baseline/pre-wire

# 2) 与基线比对：实时抓当前站点，逐元素 diff（这是接线后要跑的那条）
node apps/web/scripts/dom-snapshot.mjs --compare docs/design/2026-09-collab/baseline/pre-wire

# 3) 两份已落盘产物互比（例如把「接线后」产物先 --out 到某目录，再静态比）
node apps/web/scripts/dom-snapshot.mjs --compare <新目录> --baseline docs/design/2026-09-collab/baseline/pre-wire
```

其他参数：`--base-url <url>`（默认 `http://192.168.31.167`）、`--only doc,canvas,grid`、`--headed`、`--json`（CI 用）。
退出码：一致=0，有差异=1，参数错=2 —— 可直接卡 CI。

### 鉴权怎么解决

不点登录表单（避免登录流程本身带来 DOM 噪声），而是把登录态注入 `localStorage["gx-auth"]`（`apps/web/src/store/auth.ts:27` 的 zustand persist 键），reload 即生效。token 来源按优先级：

1. `--token <jwt>` 或环境变量 `GX_TOKEN`；
2. 环境变量 `GX_JWT_SECRET` + `GX_USER_ID`，本地按 `apps/api/src/domain/org/authState.ts:45` 的 `issueToken` 签 HS256（payload `{userId, tv, iat, exp}`）；
3. 内置默认：167 测试机 `apps/api/.env` 的 `JWT_SECRET` + 库内 `e2e@gx.local` 用户 —— 只为「一条命令就能跑」，换站点请用前两种覆盖。

> 现成账号试过不行：库里只有 `e2e@gx.local` 一个用户，密码 hash 不可逆，所以走的是注入法。

### 种子数据（必须一致，否则两次跑的不是同一个页面）

`apps/web/scripts/dom-snapshot-seed.mjs` 是种子数据的单一真源（`dom-snapshot.mjs` 直接 import 它，页面 URL 里的 docId/canvasId 都来自这里）。它是**幂等**的：按标题 / 「名称」字段值找既有对象，命中即复用；只有内容不一致才覆盖写。

```bash
node apps/web/scripts/dom-snapshot-seed.mjs --base-url http://192.168.31.167 [--out <目录>]
```

种子清单（已在 167 上建好，ID 见 `pre-wire/seed-ids.json`）：

| 对象 | 内容 |
|---|---|
| 知识库 `E2E知识库` → 文档「基线-文档」 | H1/H2 标题、段落、粗体、行内代码、外链、无序列表、代码块 |
| 同一知识库 → 画布「基线-画布」 | 4 个图形：矩形 A / 椭圆 B / 三角 C / 文本「基线画布文本 D」 |
| 数据库 `E2E验证库` → 表「数据表 1」→ 网格视图 | 5 行：名称「基线行-一..五」，数量 1..5，备注「第 N 条固定数据」 |

## 固定操作序列（复现口令）

脚本对三类页面按**同一顺序**执行同一套动作，全程不做任何 hover、拖拽、滚动、编辑：

1. **先打开库首页**：doc/canvas → `/kb/cmuazmt0t000sed30azpsdcol`；grid → `/base/cmuazigmr0005bcnbdtyn0edb`
2. **点击固定条目落到目标路由**（不是直接敲 URL）：
   - doc：点「基线-文档」→ `/kb/…/doc/cmubetwae0019ed30m006cpgl`
   - canvas：点「基线-画布」→ `/kb/…/canvas/cmubetwfv001ged3056kmbh88`
   - grid：点「数据表 1」→ `/base/…/table/…/view/…`
   - 点击未落到目标时回退为直达 URL，并在 `manifest.json` 标 `navFallback`（**回退是异常信号，正常基线里不应出现**）
3. 等渲染标志文本出现（doc=`基线快照文档`、canvas=`矩形 A`、grid=`基线行-五`）
4. 等 DOM 节点数连续 3 次不变（R11），再固定等 1200ms 让 CSS 过渡落定
5. 滚动位置归零、焦点归零（R10）→ 截图 → 抓指纹

页面顺序固定为 doc → canvas → grid（同一个浏览器上下文复用，模拟「依次点进去看」）。

## 去噪规则清单（`DENOISE_VERSION = v1`）

规则写在 `dom-snapshot.mjs` 顶部注释（R1–R12）与代码里，这里是要点与「为什么」：

| 规则 | 归一化了什么 | 为什么 |
|---|---|---|
| R1 | 结构只记 DFS 前序 + 深度 | 元素路径下标会因任一节点增删而整体错位，把「一处变化」放大成整页差异 |
| R2 | 剔除 `script/style/link/meta/noscript/template` | 不进渲染树；`assets/index-Drxbjf_o.js` 这类构建 hash 每次重构建都变，保留必然误报 |
| R3 | 剔除 `id`、`for`、`name`、`aria-controls/labelledby/describedby/owns`、`plait-data-id` | 随机身份/引用不是界面。实测 doc 页 `data-block`/`data-editable`/`data-zone-before`/`data-zone-after`/`data-focus` 值形如 `bmubf0br71a7w6`，是 slate 每次装载重新生成的块 key |
| R4 | `data-*` 走白名单（23 个语义稳定的，如 `data-nav-row`、`data-slate-node`、`data-gx-view-tab`） | 动态 `data-*` 太多，白名单比黑名单可审计；新出现的 `data-*` 默认不参与比对（属预警项，见下） |
| R5 | class：按空格拆 → 丢机器生成段（`css-1x2y3z`、`element-3f2a9b`、≥8 位十六进制、大小写数字混合的 base36 随机串）→ **排序**后拼回 | class 顺序不影响样式，排序可消除 React 重排噪声 |
| R6 | style：保留子属性名，数值四舍五入到 1 位小数 | 画布 `width:2244px`、表格列宽 `876px` 是 JS 按字体测量算出的浮点，亚像素抖动会假差异；1 位小数既压抖动又留得住真实尺寸变化 |
| R7 | SVG 数值属性（`d/transform/points/viewBox/x/y/cx/cy/r/x1…`）同样 1 位小数归一化 | 画布图元轮廓随布局/缩放变化，整数级缩放差异仍需可见 |
| R7b | **画布图形层**（`.element-host` 子树）的 `path` 的 `d` → 只留命令序列（数值全替换为 `#`），并补记 `getBBox()` 视觉包围盒 | 实测 plait 对同一几何图形每次渲染生成**视觉等价但贝塞尔控制点不同**的路径（同一矩形两次加载控制点 t 从 0.23 漂到 0.32，而控制点始终落在同一条直线上 = 视觉完全一致）。精确数值不可复现；改用「命令序列 + 视觉包围盒」，图形挪位/改尺寸/换形状仍能被发现 |
| R8 | 文本遮罩：`2026-09-21 16:33`→`<TS>`、`16:33`→`<T>`、`3 分钟前`/`刚刚`→`<REL>` | 列表与侧栏的「更新于 …」必然随时间变化，不遮罩每次跑都误报 |
| R9 | `href/src` 里的构建 hash → `<HASH>` | 换版本重构建后文件名变，与界面无关 |
| R10 | 滚动归零（含所有内部滚动容器）+ `activeElement.blur()` | 滚动位置与焦点环是「当次会话状态」，不是界面结构 |
| R11 | 等 DOM 节点数连续 3 次不变（最多 12s） | **最大误报来源不是属性噪声，而是「上一次跑时还没渲染完」** |
| R12 | 固定视口 1440×900、dpr=1、`locale=zh-CN`、`timezone=Asia/Shanghai`、`prefers-reduced-motion: reduce`、等 `document.fonts.ready` | 布局/文本测量必须同源同参 |

## 比对输出示例

**A. 与基线实时比对（本次实测，零差异）**

```console
$ node apps/web/scripts/dom-snapshot.mjs --compare docs/design/2026-09-collab/baseline/pre-wire
[capture] http://192.168.31.167 → /var/folders/.../gx-dom-live-1790006017618
  ✓ doc 361 节点
  ✓ canvas 374 节点
  ✓ grid 595 节点
基线目录：docs/design/2026-09-collab/baseline/pre-wire
当前产物：/var/folders/.../gx-dom-live-1790006017618

[doc] ✓ 零差异  节点 361 → 361  新增 0 / 删除 0 / 变更 0（合计 0）
[canvas] ✓ 零差异  节点 374 → 374  新增 0 / 删除 0 / 变更 0（合计 0）
[grid] ✓ 零差异  节点 595 → 595  新增 0 / 删除 0 / 变更 0（合计 0）

结论：全部页面逐元素一致（零差异）
```

**B. 负向验证（证明脚本不是永远报「零差异」）**

把 `grid/dom.json` 换成 `doc/dom.json` 后比对，立刻报出 614 处差异：

```console
[grid] ✗ 有差异  节点 595 → 361  新增 184 / 删除 418 / 变更 12（合计 614）
    路由变化：/base/cmuazigmr.../view/cmuazign3... → /kb/cmuazmt0t.../doc/cmubetwae...
    ~ 基线: t=span d=12 c="h-4 rounded-full w-4" a={"style":"background-color: rgb(55, 138, 221);"}
      当前: t=span d=12 c="h-4 rounded-full w-4" a={"style":"background-color: rgb(15, 110, 86);"}
    - t=button d=12 c="bg-white ease-out flex font-semibold ..." x=… a={"aria-label":"E2E验证库"}
    + t=button d=12 c="ease-out flex gap-2 h-8 hover:bg-gx-row-hover ..." a={"aria-label":"E2E知识库"}
```

## 已知盲区与误报预警（接线后判读时先看这里）

**可能漏报（真变了但抓不到）**

1. **画布图元的精确坐标/尺寸**：R7b 把画布 `path` 的 `d` 数值抽象掉了，只留命令序列 + `getBBox()` 包围盒。图形整体挪 1px 内、或路径控制点变化而包围盒不变时，DOM 层面抓不到 → **画布的几何变化请以 `screenshot.png` 为准**（本仓库暂未接入像素 diff）。
2. **`data-*` 白名单外的新属性**：接线后若新增语义 `data-*`（如 `data-collab-state`），默认不参与比对，不会报差异。
3. **文本遮罩**（R8）会吞掉时间戳/相对时间的真实变化。
4. **`aria-controls` 等引用类属性**被剔除，关联关系错乱抓不到。

**可能误报（没变却报差异）**

1. **画布/数据表列宽等测量值**：R6 只压到 1 位小数。若两次跑字号、字体回退（font fallback）或 dpr 不同，`style` 里的 px 值会差 → 报大量 `changed`。**必须同一台机器、同一 Chromium、同一 dpr 跑**。
2. **异步内容**：R11 只保证节点数稳定。若某块内容「节点数不变但内容后到」（例如骨架屏换成同尺寸内容），可能抓到中间态 → 表现为同一元素的 `x` 或 `c` 变化。排查手法：`--headed` 看是否「跑早了」。
3. **画布首屏视口**：画布视口原点不在世界坐标 (0,0)（plait 默认把原点放画布中部偏下），因此种子图形的坐标取了负值区间；若接线改动了画布初始化逻辑，图形可能整体位移 → 会被 `getBBox` 抓到（这属于**真差异**，不是误报）。
4. **随机 id 泄漏到未覆盖位置**：R3/R5 覆盖了实测到的随机源；若接线引入新的随机 class/id 形态（例如新前缀），R5 的正则可能漏网 → 报差异但实际是噪声。届时把新形态补进 `isNoisyClass` 并升 `DENOISE_VERSION`（**升级版本后必须重取基线，否则新老指纹不可比**）。
5. **表格行顺序**：若两次跑之间数据被写入/删除，行 DOM 顺序变化会如实报差异 —— 请先跑 `dom-snapshot-seed.mjs` 确认种子完整。

**比对的前提（不满足则结果无效）**

- 同一被测站点版本（本次=`192.168.31.167`，v0.1.7 接线前）；
- 同一账号（`e2e@gx.local`，注入 token）；
- 同一操作序列与页面顺序（doc → canvas → grid）；
- 种子数据未被增删改（`seed-ids.json` 里的 ID 必须仍存在）；
- 同一台机器、同一 Chromium 版本、同一 dpr（字体测量一致性）。

## 纪律

- 本次工作**没有修改任何业务代码**：`apps/api/src`、`apps/web/src` 下一个字节都没动；新增的只有
  `apps/web/scripts/dom-snapshot.mjs`、`apps/web/scripts/dom-snapshot-seed.mjs` 与本 `baseline/` 目录。
- 种子数据是**唯一**在测试机上产生的写入（经 API 建文档/画布/表格行），用于让两次跑的是同一批数据；生产库不要执行。
- 产物未做任何手工修饰，全部由脚本生成。

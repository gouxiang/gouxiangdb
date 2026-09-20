# 最后一轮真机复验报告（2026-09-20）

- 被测站：http://192.168.31.167/（nginx:80，v0.1.7）
- 入口 bundle：`assets/index-BbtcKreL.js`（上一轮为 `index-DF0tRhpY.js`，本次为含 5 个修复 + 帮助中心配图的新构建）
- 健康：`/readyz` 五探针全 true，`migration.applied`=25
- 浏览器会话：**全程只开 1 个**（`--session final`），收工已关闭并确认 `agent-browser` 进程为 0
- 截图：`docs/help-center/assets/walk/perm3-01 ~ perm3-20`
- 身份：所有者 `wk2-perm-owner@test.local`（表里 PCR vas）／阅读者 `wk2-perm-viewer@test.local`，密码一致
- 测试库/表：`WK-权限测试` / `数据表 1`（base `cmu8wjl4f01h3a8epuljreow7`，table `cmu8wjl4i01h7a8ep7dy3tnhx`）

---

## 一、复验总表

| 条目 | 修复前现象 | 本次实测（1280 宽为主） | 是否真修复 | 证据截图 |
| --- | --- | --- | --- | --- |
| **1. 帮助中心配图**（重点） | H-03 配图 broken | 页面共 **59** 张配图：**50 张正常渲染**，**9 张仍是裂图** | **部分修复**：已有的 50 张正常；剩余 9 张是**素材从未产出**（仓库 `docs/help-center/assets/` 下没有这些文件），不是渲染链路坏 | `perm3-01`~`perm3-05` |
| **2. 直输 /help（附带发现）** | H-01 直输 URL 403 | `GET /help` → 301 → `/help/` → **nginx 403 Forbidden**；SPA 内点「帮助中心」正常 | **未修复（部署层陈旧产物）**：源码已改名为 `help-assets`，但本机静态根仍残留旧目录 `help/`（`/help/assets/aggregation-bar.png` 仍返回真图 69112 字节） | `perm3-19` |
| **3. PERM-A1 导入入口（阅读者侧）** | 阅读者能看到「导入」并能走完四步向导才 403 | 阅读者工具栏：`网格视图 / 新建记录(disabled) / 筛选 / 分组 / 排序 / 导出 / 更多`，**「导入」彻底不存在**（非置灰）；「更多」菜单项为 `行高 / 字段 / 行颜色 / 复制视图`，**无导入**；1440 宽下同样无导入 | **真修复** | `perm3-17`、`perm3-20` |
| **4. PERM-A1 导入入口（有权限侧未被误伤）** | — | 所有者 @1280/1440/1600「导入」均在；真实跑通导入：上传 CSV → 字段映射（预览「导入验证行 7」）→ 开始导入 → 结果「**新增记录 1 / 新建字段 0 / 问题行·列 0**」，网格当场出现该行 | **无回归，功能照常** | `perm3-12`~`perm3-14` |
| **5. PERM-A2 工具栏溢出（不再裁切）** | 1280 下「更多」`right=1325 > 1280`，被右缘裁一半 | 所有者/阅读者 @1280：「更多」`right=1272 ≤ 1280`；「更多」菜单项 `right=1273 ≤ 1280`，均完整可见 | **真修复** | `perm3-06`、`perm3-07`、`perm3-17` |
| **6. PERM-A2 三项功能是否丢失** | — | 「更多」菜单内含 `行高 / 字段 / 行颜色`；逐个点开均可用：行高→`紧凑/常规/宽松`；字段→`新建字段/显示字段`+完整字段列表（名称/数量/状态/日期/备注/重名实验（已恢复）/重名实验）；行颜色→`无/按选择/按条件`。阅读者亦可正常打开行高面板 | **功能未丢** | `perm3-08`~`perm3-10`、`perm3-18` |
| **7. PERM-A2 ≥1440 布局未被误伤** | — | @1440：三项回到工具栏内联（行高 605-672 / 字段 676-743 / 行颜色 965-1045），「更多」`right=1432 ≤ 1440`；@1600：694-761 / 765-832 / 1054-1134，「更多」`right=1592 ≤ 1600` | **无回归** | `perm3-11`、`perm3-20` |
| **8. PERM-A2 粘滞 tooltip** | 无权限时 hover「新建记录」title 永久挂着 | DOM 结构已按改法落地：`button` 无 title 且 `pointer-events: none`；外层 `span` 持有 `title="无编辑权限"` 且 `pointer-events: auto`。真实悬停→移开实测：`mouseover=1`，移开后 `mouseout=1` 且 `mouseleave=1`（事件正常派发） | **真修复** | `perm3-15`、`perm3-16` |

---

## 二、帮助中心配图明细（第 1 项展开）

### 统计口径
页面滚动到底后统计全量 `<img>`：总数 **59**，其中 `complete && naturalWidth>0` 的 **50** 张为正常渲染；其余 **9** 张 `naturalWidth=0`（裂图）。

### 9 张裂图清单（含章节定位）

| # | 文件名 | alt | 所属章节 | 服务端响应 |
| --- | --- | --- | --- | --- |
| 4 | `base-settings-overview.png` | 库设置概览页 | 修改库的图标与颜色 | 200 / **text/html** / 773 B |
| 6 | `base-settings-share.png` | 库分享链接面板 | 库级分享链接 | 同上 |
| 9 | `table-row-menu.png` | 表行三点菜单 | 重命名数据表 | 同上 |
| 13 | `grid-header-cell-menu.png` | 表头列下拉菜单 | 编辑与重命名字段 | 同上 |
| 23 | `kanban-view.png` | 看板视图 | 六种视图分别能做什么 | 同上 |
| 25 | `calendar-view.png` | 日历视图 | 六种视图分别能做什么 | 同上 |
| 30 | `form-designer-field-settings.png` | 字段设置面板 | 在设计器里排版 | 同上 |
| 31 | `import-wizard-mapping.png` | 导入字段映射 | 导入 CSV | 同上 |
| 35 | `search-dialog.png` | 全局搜索对话框 | 用快捷键搜索全站内容 | 同上 |

### 根因（这不是渲染缺陷，是素材缺失 + 静态回退掩盖）
1. 这 9 个文件在**仓库 `docs/help-center/assets/` 下就不存在**——从未被拍到，属「待补素材」。
   - 对照：正常渲染的 `aggregation-bar.png` → `/help-assets/aggregation-bar.png` 返回 `200 / image/png / 69112 B`。
2. nginx 对本不存在的 `.png` 走了 SPA 回退，**返回 200 + `text/html` + 773 字节的 index.html**，而不是 404。浏览器拿到 HTML 无法解码图片 → 表现为裂图/空白，且不报 404，问题被静默吞掉。
   - 因此「有没有裂图」这件事在 CI/服务端日志里看不出来，只能靠 DOM 里 `naturalWidth=0` 判定。

### 正常样例（用于证明渲染链路本身是通的）
- `nav-l1-libraries.png`：naturalWidth/naturalHeight = **1280×633**，实际显示 612×303。
- 数据库侧：`doc-slash-menu.png` 等正常（第 46 张）。
- 平台侧（第 54-59 张）：`personal-center / avatar-tab / workspace-settings / workspace-assets / contacts-three-columns / mcp-connect-block` 全部正常。

---

## 三、仍然有问题的

### A. 帮助中心仍有 9 处裂图 —— 素材未产出（P2）
上表 9 张。**建议处理方式（非修代码，只给方向）**：
1. 补拍这 9 张截图到 `docs/help-center/assets/`（表内已给出每张该截什么界面）。
2. 更根上的一条：**帮助中心同步/构建期校验引用的配图文件必须存在**，缺图直接失败或告警，避免再漏。
3. 部署层：**不存在的静态资源不要回退成 index.html**（至少对 `.png/.jpg/.css/.js` 等静态后缀返回 404），否则「缺图」永远伪装成一个 200。

### B. 直接访问 /help 仍然 403 —— 部署层陈旧产物未清理（P2）
- 现象：`http://192.168.31.167/help` → 301 → `/help/` → **nginx 403 Forbidden**。SPA 内点「帮助中心」可用，**刷新、在新标签打开、把链接发给别人 → 必 403**。
- 判定：源码侧 H-01 的改法（配图目录改名为 `help-assets`）已经生效——页面引用的确是 `/help-assets/xxx.png`，且 `/help-assets/` 服务正常；**但本机静态根里那个旧的 `help/` 目录没有被删掉**（`/help/assets/aggregation-bar.png` 依旧能取到真图 69112 字节，证明旧副本还在）。只要真实目录 `help/` 存在，nginx 就会先按目录处理，`/help/` 因无 index 且 autoindex off 而 403。
- **这是部署侧残留，不是源码改错**：删掉静态根下的旧 `help/` 目录（只保留 `help-assets/`）即可闭环。

### C. 「更多」浮层里打开「行颜色」面板，内容被压窄需横向滚动（P3，本轮新现象）
- 复现：视口 1280 → 工具栏「更多」→ 点「行颜色」。
- 实测：浮层容器 `x=985, right=1272`（宽 288，`overflow-hidden`），内层内容 `w-80` = **320px**，父级 `scrollWidth 320 / clientWidth 286` → 面板内出现横向滚动条。
- 对比：≥1440 从内联入口打开时，面板完整 320px（`scrollWidth 320 / clientWidth 318`），无此现象。
- 不影响功能（内容没丢），但窄屏下要看全需横向拖。
- 同一浮层里「行高」（紧凑/常规/宽松）与「字段」面板宽度自适应，未受影响。

### D. 上一轮遗留、本轮未涉及、仍待裁决
- PERM-A3：阅读者仍能在库设置里看到全部成员邮箱（口径决策，未改）。
- OBS-01：编辑者 `POST /api/tables/:id/clear` 返回 200（已上报待裁决）。

---

## 四、本轮在站上留下的数据变更
- 为验证「有权限者导入功能照常」，在 `WK-权限测试 / 数据表 1` 真实导入了 **1 行**：`导入验证行 / 7`。如需清库请删除该行。
- 未改动任何源码、未提交代码。

---

## 五、收工进程确认
```
$ ps aux | grep -i "agent-browser" | grep -v grep | wc -l
0
$ ps aux | grep -i "chrome" | grep -v grep | grep -i -c "headless"
0
```
全程仅使用 1 个 `--session final`，任务结束后已执行 `agent-browser close`（返回 `✓ Browser closed`）。

补充说明：`ps aux | grep chrome` 仍可见 17 条，但逐条核对后全部为用户自己的应用
（`/Applications/Google Chrome.app` 10 个 helper、`NeteaseMusic Helper`、`WorkBuddy` 的 chrome_crashpad_handler、
系统 `PasswordManagerBrowserExtensionHelper`），**本轮会话产生的 headless chrome 为 0**，无残留。
截图产出：`perm3-01 ~ perm3-20`，共 20 张。

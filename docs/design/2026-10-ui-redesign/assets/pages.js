/* ============================================================
   全站页面清单（来源：apps/web/src/App.tsx 真实路由 + features/ 模块）
   ------------------------------------------------------------
   每组 = 一组页面；每页 = 一个骨架。
   kind: shell      = 落在主壳内（TopBar + L1 + L2 + 内容区）
         standalone = 脱离主壳的独立页
         overlay    = 在主壳之上叠加浮层
   blocks: 内容区区域划分（只表达结构，不表达样式细节）
          { name, note, h }        固定高
          { name, note, flex:n }   弹性
          { row: [...], h }        横向并排
   ============================================================ */

window.GX_GROUPS = [
  "入口与独立页",
  "数据表库",
  "知识库",
  "工作区与全局",
];

window.GX_PAGES = [
  /* ========== 入口与独立页 ========== */
  {
    id: "login",
    group: "入口与独立页",
    name: "登录",
    route: "/login",
    kind: "standalone",
    blocks: [
      { name: "品牌区", note: "标识 + 一句话定位", h: 72 },
      { name: "账号 / 密码", note: "字段 + 主按钮 + 错误行", h: 148 },
      { name: "辅助入口", note: "忘记密码 · 邀请链接提示", h: 40 },
    ],
  },
  {
    id: "launcher",
    group: "入口与独立页",
    name: "启动器（本机模式）",
    route: "/launcher",
    kind: "standalone",
    blocks: [
      { name: "四态指示", note: "未启动 / 启动中 / 就绪 / 失败，实时轮询", h: 96 },
      { name: "本机库入口", note: "空册时作为主入口：新建 / 打开已有", h: 120 },
      { name: "启动 / 停止", note: "独立启停，不切换当前活动源", h: 44 },
      { name: "错误条", note: "失败原因 + 重试，收口在一条内", h: 56 },
    ],
  },
  {
    id: "change-pw",
    group: "入口与独立页",
    name: "强制改密",
    route: "/change-password",
    kind: "standalone",
    blocks: [
      { name: "说明区", note: "为何要求修改（首次登录）", h: 64 },
      { name: "新密码表单", note: "强度提示 + 二次确认", h: 132 },
      { name: "提交 / 退出", note: "白名单外一律 403", h: 40 },
    ],
  },
  {
    id: "join",
    group: "入口与独立页",
    name: "加入空间（邀请）",
    route: "/join/:token · /invite/:token",
    kind: "standalone",
    blocks: [
      { name: "邀请信息", note: "库名 · 邀请人 · 角色", h: 88 },
      { name: "身份选择", note: "已登录直接用；未登录走登录/注册", h: 96 },
      { name: "接受 / 拒绝", note: "token 失效态单独呈现", h: 40 },
    ],
  },
  {
    id: "public-share",
    group: "入口与独立页",
    name: "公开分享页",
    route: "/s/:token · /s/:token/doc/:docId",
    kind: "standalone",
    blocks: [
      { name: "只读页头", note: "分享标题 + 只读徽标 + 登录入口", h: 56 },
      { name: "分享内容", note: "表 / 文档只读渲染，无任何写入口", h: 420 },
      { name: "页脚", note: "由「构想工作台」提供", h: 40 },
    ],
  },
  {
    id: "help",
    group: "入口与独立页",
    name: "帮助中心",
    route: "/help",
    kind: "standalone",
    blocks: [
      { row: [
        { name: "目录", note: "主题分组，左固定", flex: 1 },
        { name: "正文", note: "图文混排 + 锚点跳转", flex: 3 },
      ], h: 560 },
    ],
  },

  /* ========== 数据表库 ========== */
  {
    id: "grid",
    group: "数据表库",
    name: "数据表主界面 ★基准页",
    route: "/base/:baseId/table/:tableId/view/:viewId",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { name: "视图工具条", note: "视图名 · 筛选 / 分组 / 排序 · 搜索 · 新建记录 · 行高", h: 44 },
      { name: "暂存提示条", note: "有未保存条件时出现，可一键还原（条件占位，不撑高）", h: 0 },
      { name: "数据网格", note: "表头 32 · 行 36 · 首列固定 · 行尾三点 hover 才现但留 20×20 占位", flex: 1, solid: true },
      { name: "聚合行", note: "列求和 / 计数，贴底吸附", h: 32 },
      { name: "状态条", note: "总行数 · 已选 · 同步状态 · 只读标记", h: 28 },
    ],
  },
  {
    id: "record-drawer",
    group: "数据表库",
    name: "记录详情抽屉",
    route: "?rec=<id>（叠在 grid 上）",
    kind: "overlay",
    base: "grid",
    overlay: {
      type: "drawer",
      blocks: [
        { name: "抽屉头", note: "记录标题（可编辑）· 左右翻页 · 关闭 · ?rec 可分享", h: 52 },
        { name: "字段区", note: "按字段类型渲染，密度同表格", flex: 1 },
        { name: "评论 / 历史", note: "分段切换，不新开页", h: 200 },
      ],
    },
  },
  {
    id: "gallery",
    group: "数据表库",
    name: "画廊视图",
    route: "?view=gallery",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { name: "视图工具条", note: "与表格一致，避免每换视图就换一套工具条", h: 44 },
      { name: "封面卡片区", note: "卡片 = 封面 + 标题 + 3~5 个关键字段，列宽随容器自适应", flex: 1 },
      { name: "状态条", note: "总卡片数 · 已选", h: 28 },
    ],
  },
  {
    id: "kanban",
    group: "数据表库",
    name: "看板视图",
    route: "?view=kanban",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { name: "视图工具条", note: "分组字段切换器放这里", h: 44 },
      { row: [
        { name: "分组列 A", note: "列头（组名 + 计数 + 操作）+ 卡片堆 + 列尾新建", flex: 1 },
        { name: "分组列 B", note: "拖拽落点高亮", flex: 1 },
        { name: "分组列 C", note: "空组也要可见（可在此新建）", flex: 1 },
        { name: "分组列 D", note: "横向滚动，列宽固定", flex: 1 },
      ], flex: 1 },
    ],
  },
  {
    id: "calendar",
    group: "数据表库",
    name: "日历视图",
    route: "?view=calendar",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { name: "时间轴头", note: "月 / 周切换 · 今天 · 前后翻", h: 44 },
      { name: "日历网格", note: "日期格 + 事件条，跨天事件横跨；今天列高亮", flex: 1, solid: true },
    ],
  },
  {
    id: "form-fill",
    group: "数据表库",
    name: "表单填写页",
    route: "?view=form（对外填写）",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { row: [
        { name: "表单说明", note: "标题 + 描述 + 提交上限提示", flex: 2 },
        { name: "字段列表", note: "按表单配置顺序，必填标记，提交按钮贴底", flex: 3 },
      ], flex: 1 },
      { name: "提交结果", note: "成功态 / 已达上限 / 已关闭，三种独立呈现", h: 0 },
    ],
  },
  {
    id: "form-config",
    group: "数据表库",
    name: "表单配置",
    route: "?view=form&config=1",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { row: [
        { name: "字段池", note: "可拖入表单的字段，含隐藏字段", flex: 1 },
        { name: "表单结构", note: "排序 / 必填 / 说明文案 / 分组", flex: 2 },
        { name: "实时预览", note: "与填写页同一渲染，所见即所得", flex: 2 },
      ], flex: 1 },
      { name: "保存条", note: "未保存时出现，离开前拦截", h: 44 },
    ],
  },
  {
    id: "tree",
    group: "数据表库",
    name: "树视图",
    route: "?view=tree",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { name: "视图工具条", note: "层级字段选择器", h: 44 },
      { name: "层级树", note: "缩进 24/层 · 展开箭头只展开不跳转 · 行尾操作留占位", flex: 1, solid: true },
    ],
  },
  {
    id: "gantt",
    group: "数据表库",
    name: "甘特视图",
    route: "?view=gantt",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    tabs: ["表格", "看板", "画廊", "日历", "表单"],
    blocks: [
      { name: "时间刻度", note: "日 / 周 / 月三档", h: 36 },
      { row: [
        { name: "任务列", note: "固定左列，标题 + 负责人", flex: 1 },
        { name: "条形区", note: "条形 + 依赖线 + 今日线", flex: 3 },
      ], flex: 1 },
    ],
  },
  {
    id: "erd",
    group: "数据表库",
    name: "ER 图",
    route: "/base/:baseId/erd",
    kind: "shell",
    l1: "tables",
    l2: null,
    blocks: [
      { name: "ERD 工具条", note: "自动布局 · 缩放 · 导出图片", h: 44 },
      { name: "关系画布", note: "表节点 + 关联线；节点可拖，位置需持久化", flex: 1, solid: true },
    ],
  },
  {
    id: "base-settings",
    group: "数据表库",
    name: "库设置",
    route: "/base/:baseId/settings",
    kind: "shell",
    l1: "tables",
    l2: "settings",
    blocks: [
      { name: "页头", note: "标题 15/600 + 一句话说明（脱离壳时唯一的标题位置）", h: 56 },
      { name: "设置 Tab", note: "概览 · 数据表 · 危险操作", h: 40 },
      { name: "设置内容", note: "概览=统计卡；数据表=表清单；危险操作=二次确认区", flex: 1 },
    ],
  },
  {
    id: "base-trash",
    group: "数据表库",
    name: "库回收站",
    route: "/base/:baseId/trash",
    kind: "shell",
    l1: "tables",
    l2: "settings",
    blocks: [
      { name: "页头", note: "标题 + 保留期说明 + 清空入口（危险色）", h: 56 },
      { name: "回收列表", note: "类型 / 原名 / 删除人 / 剩余天数 / 恢复 · 彻底删除", flex: 1, solid: true },
    ],
  },
  {
    id: "filter-panel",
    group: "数据表库",
    name: "筛选面板（浮层）",
    route: "叠在 grid 工具条下",
    kind: "overlay",
    base: "grid",
    overlay: {
      type: "popover",
      blocks: [
        { name: "条件行", note: "字段 · 运算符 · 值；多行 and/or 切换", h: 160 },
        { name: "当前用户变量", note: "「当前用户」作为值，只读提示", h: 40 },
        { name: "底部操作", note: "清空 · 取消 · 应用（应用后条件进 URL）", h: 48 },
      ],
    },
  },
  {
    id: "import",
    group: "数据表库",
    name: "导入向导",
    route: "弹窗（三步）",
    kind: "overlay",
    base: "grid",
    overlay: {
      type: "modal",
      blocks: [
        { name: "步骤条", note: "选文件 → 映射字段 → 校验结果", h: 48 },
        { name: "映射表", note: "CSV 列 ↔ 表字段，自动匹配 + 手动改", flex: 1 },
        { name: "校验结果", note: "可导入 / 跳过 / 错误行，逐条原因", h: 120 },
        { name: "底部操作", note: "上一步 · 取消 · 开始导入", h: 44 },
      ],
    },
  },

  /* ========== 知识库 ========== */
  {
    id: "kb-list",
    group: "知识库",
    name: "知识库列表",
    route: "/kb",
    kind: "shell",
    l1: "kb",
    l2: null,
    blocks: [
      { name: "页头", note: "标题 + 新建知识库", h: 56 },
      { name: "库卡片网格", note: "卡片 = 名 + 文档数 + 最近更新；空态引导建第一个", flex: 1 },
    ],
  },
  {
    id: "kb-home",
    group: "知识库",
    name: "知识库首页",
    route: "/kb/:kbId",
    kind: "shell",
    l1: "kb",
    l2: "docs",
    blocks: [
      { name: "库概览", note: "库名 + 简介 + 统计 + 快捷新建", h: 88 },
      { row: [
        { name: "最近编辑", note: "按时间倒序的文档列表", flex: 1 },
        { name: "置顶 / 收藏", note: "手动维护，空时整块隐藏", flex: 1 },
      ], flex: 1 },
    ],
  },
  {
    id: "doc-editor",
    group: "知识库",
    name: "文档编辑器",
    route: "/kb/:kbId/doc/:docId",
    kind: "shell",
    l1: "kb",
    l2: "docs",
    blocks: [
      { name: "编辑器顶栏", note: "标题可编辑 input（无边框）· 保存态 · 协作头像 · 更多", h: 52 },
      { row: [
        { name: "正文", note: "版心 720，左右留白；块级悬浮工具条", flex: 3, solid: true },
        { name: "右侧大纲", note: "标题锚点，滚动跟随，可收起", w: 200 },
      ], flex: 1 },
    ],
  },
  {
    id: "canvas",
    group: "知识库",
    name: "画布编辑器",
    route: "/kb/:kbId/canvas/:docId",
    kind: "shell",
    l1: "kb",
    l2: "docs",
    blocks: [
      { name: "画布顶栏", note: "标题 · 缩放 · 协作态", h: 52 },
      { name: "画布", note: "无限画布 + 浮动工具栏；选中对象才出属性条", flex: 1, solid: true },
    ],
  },
  {
    id: "kb-trash",
    group: "知识库",
    name: "知识库回收站",
    route: "/kb/:kbId/trash",
    kind: "shell",
    l1: "kb",
    l2: "settings",
    blocks: [
      { name: "页头", note: "标题 + 保留期", h: 56 },
      { name: "文档回收列表", note: "路径 / 删除人 / 剩余天数 / 恢复", flex: 1, solid: true },
    ],
  },
  {
    id: "kb-settings",
    group: "知识库",
    name: "知识库设置",
    route: "/kb/:kbId/settings",
    kind: "shell",
    l1: "kb",
    l2: "settings",
    blocks: [
      { name: "页头", note: "标题 + 说明", h: 56 },
      { name: "设置内容", note: "基本信息 · 成员与角色 · 危险操作", flex: 1 },
    ],
  },

  /* ========== 工作区与全局 ========== */
  {
    id: "contacts",
    group: "工作区与全局",
    name: "通讯录",
    route: "/workspace/contacts",
    kind: "shell",
    l1: "contacts",
    l2: null,
    blocks: [
      { name: "页头", note: "搜索成员 · 邀请 · 导出", h: 56 },
      { name: "成员表", note: "头像 / 姓名 / 邮箱 / 角色 / 最近活跃 / 操作", flex: 1, solid: true },
    ],
  },
  {
    id: "authz",
    group: "工作区与全局",
    name: "权限管理",
    route: "/workspace/authz",
    kind: "shell",
    l1: "authz",
    l2: null,
    blocks: [
      { row: [
        { name: "角色列表", note: "内置 + 自定义角色，可复制", flex: 1 },
        { name: "权限矩阵", note: "资源 × 操作勾选，改动即时提示影响面", flex: 3 },
      ], flex: 1 },
    ],
  },
  {
    id: "ws-settings",
    group: "工作区与全局",
    name: "工作区设置",
    route: "/workspace/settings/*",
    kind: "shell",
    l1: "settings",
    l2: "settings",
    blocks: [
      { name: "页头", note: "标题 + 说明", h: 56 },
      { row: [
        { name: "设置项菜单", note: "基本 · 成员 · PAT · 分享链接 · MCP", flex: 1 },
        { name: "设置内容", note: "按分区开关渲染，未启用的分区整体隐藏", flex: 3 },
      ], flex: 1 },
    ],
  },
  {
    id: "personal",
    group: "工作区与全局",
    name: "个人中心（抽屉）",
    route: "点 L1 用户卡片",
    kind: "overlay",
    base: "grid",
    overlay: {
      type: "drawer",
      blocks: [
        { name: "身份区", note: "头像 · 昵称 · 邮箱 · 角色徽标", h: 88 },
        { name: "偏好", note: "主题 · 语言 · 快捷键入口", flex: 1 },
        { name: "账户操作", note: "改密 · 退出登录", h: 80 },
      ],
    },
  },
  {
    id: "search",
    group: "工作区与全局",
    name: "全局搜索（浮层）",
    route: "⌘K",
    kind: "overlay",
    base: "grid",
    overlay: {
      type: "modal",
      blocks: [
        { name: "输入行", note: "大号输入 + 范围切换（全部 / 当前库）", h: 56 },
        { name: "结果分组", note: "数据表 / 文档 / 成员 分组，键盘上下选择", flex: 1 },
        { name: "底部提示", note: "↑↓ 选择 · ↵ 打开 · esc 关闭", h: 36 },
      ],
    },
  },
  {
    id: "states",
    group: "工作区与全局",
    name: "五态样张 ★必看",
    route: "内容区通用",
    kind: "shell",
    l1: "tables",
    l2: "tables",
    blocks: [
      { name: "① 加载中", note: "骨架屏，不用转圈；保持行高不发生跳动", h: 96 },
      { name: "② 空数据", note: "说明 + 一个主行动；区分「还没有」与「筛选后为空」", h: 96 },
      { name: "③ 出错", note: "原因一行 + 重试；不吞错误码（可折叠展开）", h: 96 },
      { name: "④ 无权限", note: "就地渲染，不跳登录；说清缺哪个权限、找谁要", h: 96 },
      { name: "⑤ 超长文本", note: "标题 / 单元格 / 标签 各自截断策略与 hover 全文", h: 96 },
    ],
  },
];

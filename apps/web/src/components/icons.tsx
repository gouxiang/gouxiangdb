// apps/web/src/components/icons.tsx
// 纯 SVG 图标集（不使用 emoji，保证跨端视觉一致）
// 统一 24x24 viewBox，stroke 风格，currentColor 着色

import { useId } from "react";
import type { SVGProps } from "react";

export type IconName =
  | "chevronDown"
  | "chevronRight"
  | "chevronLeft"
  | "chevronUp"
  | "plus"
  | "minus"
  | "search"
  | "filter"
  | "sortAsc"
  | "sortDesc"
  | "settings"
  | "trash"
  | "close"
  | "check"
  | "more"
  | "moreVertical"
  | "table"
  | "grid"
  | "gallery"
  | "kanban"
  | "calendar"
  | "gantt"
  | "chart"
  | "form"
  | "detail"
  | "link"
  | "lock"
  | "eye"
  | "eyeOff"
  | "edit"
  | "copy"
  | "download"
  | "upload"
  | "user"
  | "users"
  | "share"
  | "star"
  | "arrowUp"
  | "arrowDown"
  | "group"
  | "palette"
  | "comment"
  | "refresh"
  | "database"
  | "help"
  | "logout"
  | "menu"
  | "bell"
  | "expand"
  | "collapse"
  | "rowHeight"
  | "field"
  | "formula"
  | "number"
  | "text"
  | "clock"
  | "paperclip"
  | "phone"
  | "mail"
  | "globe"
  | "percent"
  | "hash"
  | "toggleLeft"
  | "tags"
  | "circle"
  | "sparkles"
  | "alertCircle"
  | "cornerDownRight"
  | "swap"
  | "book"
  | "doc"
  | "canvas"
  | "history"
  | "rollback"
  | "restore"
  | "save"
  | "shield"
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "list"
  | "quote"
  | "image"
  | "video"
  | "audio"
  | "file"
  | "underline"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "lineStraight"
  | "lineCurve"
  | "lineElbow"
  | "arrowEnd"
  | "arrowStart"
  | "notePin"
  | "external"
  | "layers"
  | "bringForward"
  | "sendBackward"
  | "bringToFront"
  | "sendToBack"
  | "building"
  | "userPlus"
  | "userSlash"
  | "crown"
  | "keyRound"
  | "sitemap"
  | "grip"
  | "folder"
  | "folderOpen"
  | "folderPlus"
  | "unlock"
  | "inherit"
  | "cutoff"
  | "linkExternal"
  // 菜单精细化（L1 个人区）：首页 / 待办
  | "home"
  | "checkSquare"
  // 评论：@ 提及 / 回复
  | "at"
  | "reply"
  // 离线同步：同步中心 / 合并裁决 / 失权隔离
  | "sync"
  | "merge"
  // 工作流引擎：流程节点 + 流向连线（刀C2 导航入口/停用指引卡）
  | "workflow"
  | "shieldOff";

const PATHS: Record<IconName, string[]> = {
  chevronDown: ["M6 9l6 6 6-6"],
  chevronRight: ["M9 6l6 6-6 6"],
  chevronLeft: ["M15 6l-6 6 6 6"],
  chevronUp: ["M6 15l6-6 6 6"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.35-4.35"],
  filter: ["M3 5h18", "M6 12h12", "M10 19h4"],
  sortAsc: ["M4 7h10", "M4 12h7", "M4 17h4", "M17 17V7", "M17 7l-3 3"],
  sortDesc: ["M4 7h4", "M4 12h7", "M4 17h10", "M17 17V7", "M17 17l3-3"],
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  ],
  trash: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 14h10l1-14", "M10 11v5", "M14 11v5"],
  close: ["M18 6L6 18", "M6 6l12 12"],
  check: ["M20 6L9 17l-5-5"],
  more: [
    "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  ],
  // 竖向三点（行尾操作菜单入口，R-N-11/12）：三圆点沿 y 轴排列，与横向 more 区分
  moreVertical: [
    "M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  ],
  table: ["M3 5h18v14H3z", "M3 10h18", "M9 10v9", "M15 10v9"],
  grid: ["M3 5h18v14H3z", "M3 10h18", "M3 15h18", "M9 5v14", "M15 5v14"],
  gallery: ["M3 5h8v8H3z", "M13 5h8v8h-8z", "M3 15h8v4H3z", "M13 15h8v4h-8z"],
  kanban: ["M4 4h4v16H4z", "M10 4h4v10h-4z", "M16 4h4v13h-4z"],
  calendar: ["M3 6h18v15H3z", "M3 11h18", "M8 3v4", "M16 3v4"],
  gantt: ["M3 4h18v16H3z", "M6 7h8v2H6z", "M6 11h12v2H6z", "M6 15h6v2H6z"],
  // 柱图：一条基线 + 三根递增竖条，24 坐标线性描边，无填充
  chart: ["M3 21h18", "M7 21v-6", "M12 21V8", "M17 21v-9"],
  form: ["M5 3h14v18H5z", "M9 8h6", "M9 12h6", "M9 16h3"],
  detail: ["M4 6h16", "M4 12h16", "M4 18h10"],
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ],
  lock: ["M6 11h12v10H6z", "M9 11V7a3 3 0 0 1 6 0v4"],
  eye: [
    "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
  // 闭眼：在 eye 基础上多一道斜线（feather eye-off），登录页密码可见切换用
  eyeOff: [
    "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94",
    "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19",
    "M14.12 14.12a3 3 0 1 1-4.24-4.24",
    "M1 1l22 22",
  ],
  edit: [
    "M11 4H4v16h16v-7",
    "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
  ],
  copy: ["M9 9h10v10H9z", "M5 15H4V4h11v1"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M4 21h16"],
  upload: ["M12 21V9", "M7 14l5-5 5 5", "M4 3h16"],
  user: [
    "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
    "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  ],
  users: [
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M23 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  share: [
    "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7",
    "M16 6l-4-4-4 4",
    "M12 2v13",
  ],
  star: [
    "M12 3l2.9 5.9 6.1.9-4.5 4.3 1.1 6.1L12 17.3 6.4 20.2l1.1-6.1L3 9.8l6.1-.9L12 3z",
  ],
  arrowUp: ["M12 19V5", "M5 12l7-7 7 7"],
  arrowDown: ["M12 5v14", "M19 12l-7 7-7-7"],
  group: ["M3 5h18", "M6 10h12", "M9 15h6"],
  palette: [
    "M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-1.5a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 21z",
    "M7.5 10.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M10.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M15.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  ],
  comment: [
    "M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5z",
  ],
  refresh: ["M21 12a9 9 0 1 1-3-6.7", "M21 3v6h-6"],
  database: [
    "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3z",
    "M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5",
    "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  ],
  help: [
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5",
    "M12 17.5h.01",
  ],
  logout: [
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    "M16 17l5-5-5-5",
    "M21 12H9",
  ],
  menu: ["M3 6h18", "M3 12h18", "M3 18h18"],
  bell: [
    "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9",
    "M13.7 21a2 2 0 0 1-3.4 0",
  ],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  collapse: ["M4 14h6v6", "M20 10h-6V4", "M14 10l7-7", "M3 21l7-7"],
  rowHeight: ["M3 5h18", "M3 12h18", "M3 19h18", "M8 3v4", "M8 17v4"],
  field: ["M4 5h16v14H4z", "M9 5v14"],
  formula: ["M4 5h16v14H4z", "M9 9l2 3-2 3", "M15 9h-3", "M12 12h3"],
  number: ["M10 4L8 20", "M16 4l-2 16", "M4 9h16"],
  text: ["M5 6h14", "M12 6v14", "M9 20h6"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  paperclip: [
    "M21 11.5l-9 9a5.5 5.5 0 0 1-7.8-7.8l9-9a3.5 3.5 0 0 1 5 5l-9 9a1.5 1.5 0 0 1-2.1-2.1l8.5-8.5",
  ],
  phone: [
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
  ],
  mail: ["M4 5h16v14H4z", "M4 6l8 7 8-7"],
  globe: [
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    "M3 12h18",
    "M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z",
  ],
  percent: [
    "M19 5L5 19",
    "M6.5 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    "M17.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  ],
  hash: ["M4 9h16", "M4 15h16", "M10 3L8 21", "M16 3l-2 18"],
  toggleLeft: [
    "M8 5h8a7 7 0 0 1 0 14H8A7 7 0 0 1 8 5z",
    "M8 12a3 3 0 1 0 0-.01z",
  ],
  tags: [
    "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 3 12V4h8a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 1.6z",
    "M7.5 7.5h.01",
  ],
  circle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"],
  sparkles: [
    "M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z",
    "M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z",
  ],
  alertCircle: [
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    "M12 8v5",
    "M12 16h.01",
  ],
  cornerDownRight: ["M15 10l5 5-5 5", "M4 4v7a4 4 0 0 0 4 4h12"],
  swap: ["M8 3L4 7l4 4", "M4 7h16", "M16 21l4-4-4-4", "M20 17H4"],
  book: [
    "M12 6.5C10.5 5 8 4.5 5.5 4.5v14c2.5 0 5 .5 6.5 2",
    "M12 6.5C13.5 5 16 4.5 18.5 4.5v14c-2.5 0-5 .5-6.5 2",
    "M12 6.5v14",
  ],
  doc: [
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M9 13h6",
    "M9 17h4",
  ],
  canvas: ["M3 4h18v16H3z", "M7.5 15.5l2.5-4 2 2.5 2-3.5 2.5 5"],
  history: ["M3 12a9 9 0 1 0 2.6-6.4", "M3 4v4h4", "M12 8v4l2.5 2"],
  rollback: ["M9 14L4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-2"],
  restore: ["M3.5 9a9 9 0 1 1 2 6.5", "M3.5 4v5h5"],
  save: [
    "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z",
    "M7 21v-8h10v8",
    "M7 3v5h7",
  ],
  shield: ["M12 3l7 3v5.5c0 4.6-3 7.8-7 9-4-1.2-7-4.4-7-9V6z"],
  bold: [
    "M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z",
    "M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z",
  ],
  italic: ["M19 4h-9", "M14 20H5", "M15 4L9 20"],
  strikethrough: [
    "M16 4H9a3 3 0 0 0-2.83 4",
    "M14 12a4 4 0 0 1 0 8H6",
    "M4 12h16",
  ],
  code: ["M16 18l6-6-6-6", "M8 6l-6 6 6 6"],
  list: [
    "M8 6h13",
    "M8 12h13",
    "M8 18h13",
    "M3.5 6h.01",
    "M3.5 12h.01",
    "M3.5 18h.01",
  ],
  quote: ["M6 4v16", "M11 8h8", "M11 12h8", "M11 16h5"],
  image: [
    "M3 5h18v14H3z",
    "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    "M21 15l-5-5L5 21",
  ],
  video: ["M2 7h13v10H2z", "M15 10l7-3v10l-7-3"],
  audio: [
    "M9 18V5l11-2v13",
    "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M20 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
  file: [
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
    "M14 2v6h6",
  ],
  underline: ["M7 4v6a5 5 0 0 0 10 0V4", "M5 21h14"],
  alignLeft: ["M4 6h16", "M4 12h10", "M4 18h13"],
  alignCenter: ["M4 6h16", "M7 12h10", "M5.5 18h13"],
  alignRight: ["M4 6h16", "M10 12h10", "M7 18h13"],
  lineStraight: ["M4 20L20 4"],
  lineCurve: ["M4 20C8 20 16 8 20 4"],
  lineElbow: ["M5 19V9h14", "M16 5l3 4-3 4"],
  arrowEnd: ["M4 12h15", "M13 6l6 6-6 6"],
  arrowStart: ["M20 12H5", "M11 6l-6 6 6 6"],
  notePin: [
    "M9 3h6l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M9 12h6",
    "M9 16h4",
  ],
  external: [
    "M14 4h6v6",
    "M20 4l-9 9",
    "M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
  ],
  // 图层（叠放）
  layers: ["M12 3l9 5-9 5L3 8l9-5z", "M3 13l9 5 9-5", "M3 18l9 5 9-5"],
  // 上移一层：单步上箭头 + 底线
  bringForward: ["M12 19V8", "M7 13l5-5 5 5", "M5 21h14"],
  // 下移一层：单步下箭头 + 顶线
  sendBackward: ["M12 5v11", "M7 11l5 5 5-5", "M5 3h14"],
  // 置于顶层：双上箭头
  bringToFront: ["M6 15l6-6 6 6", "M6 20l6-6 6 6"],
  // 置于底层：双下箭头
  sendToBack: ["M6 9l6 6 6-6", "M6 4l6 6 6-6"],
  // M2 通讯录：组织（楼宇）
  building: [
    "M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16",
    "M14 21V9a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v12",
    "M3 21h18",
    "M7 7h2",
    "M7 11h2",
    "M7 15h2",
    "M17 11h.01",
    "M17 15h.01",
  ],
  // 加成员：人 + 加号
  userPlus: [
    "M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M19 8v6",
    "M16 11h6",
  ],
  // 停用成员：人 + 斜杠
  userSlash: [
    "M16.5 16.5a4 4 0 0 0-6 0",
    "M9 11a4 4 0 0 1-2.8-6.8",
    "M2.5 21v-1.2A4 4 0 0 1 5 16.2",
    "M17 22l5-20",
  ],
  // 所有者/系统角色：皇冠
  crown: ["M3 17l-1-9 5 4 5-7 5 7 5-4-1 9z", "M3 21h18"],
  // 激活/密钥（邀请结果/激活）
  keyRound: [
    "M15.5 8.5a4.5 4.5 0 1 1-6.3 4.2L3 19v-2h2v-2h2l1.2-1.2a4.5 4.5 0 0 1 7.3-5.3z",
  ],
  // 组织层级/授予部门
  sitemap: [
    "M4 4h6v5H4z",
    "M14 15h6v5h-6z",
    "M7 9v3h10V9",
    "M7 12h10",
    "M17 12v3",
  ],
  // 拖拽手柄（导航编排）
  grip: [
    "M9 5h.01",
    "M9 12h.01",
    "M9 19h.01",
    "M15 5h.01",
    "M15 12h.01",
    "M15 19h.01",
  ],
  // 菜单容器文件夹（关闭/打开/新建）
  folder: [
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  ],
  folderOpen: [
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H6l-3 8z",
    "M3 18l3-8h15l-3 8z",
  ],
  folderPlus: [
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M12 10v5",
    "M9.5 12.5h5",
  ],
  // 外部/失效引用提示
  linkExternal: [
    "M14 4h6v6",
    "M20 4l-9 9",
    "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4",
  ],
  // M4 权限：恢复继承（开锁钩）
  unlock: ["M6 11h12v10H6z", "M9 11V8a3 3 0 0 1 5.5-1.8"],
  // M4 权限：继承（来源向外分发，share-nodes 语义）
  inherit: [
    "M18 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    "M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    "M18 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    "M8.6 13.5l6.8 4",
    "M15.4 6.5l-6.8 4",
  ],
  // M4 权限：继承边界/截断（链路中间断开打叉）
  cutoff: [
    "M4 12h5.5",
    "M14.5 12H20",
    "M10.8 9.6l2.4 4.8",
    "M13.2 9.6l-2.4 4.8",
  ],
  // 首页（L1 个人区「工作台首页」）：屋顶 + 墙体 + 门洞
  home: ["M3 10.5L12 3l9 7.5", "M5.5 9.6V20h13V9.6", "M9.5 20v-5.5h5V20"],
  // 待办（L1 个人区「我的待办」）：方框 + 对勾
  checkSquare: ["M4 5h16v14H4z", "M8 12.5l2.6 2.6L16.5 9"],
  // 评论 @ 提及：@ 符号（外环 + 内回绕）
  at: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9",
  ],
  // 回复：转弯箭头（与 cornerDownRight 同语义，独立名便于评论内引用）
  reply: ["M15 10l5 5-5 5", "M4 4v7a4 4 0 0 0 4 4h12"],
  // 离线同步：双向环形箭头（区别于 refresh 的单向弧）
  sync: [
    "M20 12a8 8 0 0 1-13.7 5.7",
    "M4 12a8 8 0 0 1 13.7-5.7",
    "M18 2v5h-5",
    "M6 22v-5h5",
  ],
  // 合并裁决：两条分支汇入一条主干
  merge: ["M7 4v6a4 4 0 0 0 4 4h6", "M17 4v6", "M7 20h10"],
  // 工作流：两个节点方块 + 一条带流向的连线（纯描边，无 fill 面）
  workflow: ["M5 5h5v5H5z", "M14 14h5v5h-5z", "M10 7.5h3a2 2 0 0 1 2 2V14"],
  // 失权隔离：盾牌 + 斜杠
  shieldOff: [
    "M12 3l7 3v5.5c0 4.6-3 7.8-7 9-4-1.2-7-4.4-7-9V6z",
    "M4 4l16 16",
  ],
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  ...rest
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/**
 * 品牌 G 标志（构想）。几何与色带的唯一事实源：branding/app-icon/gen-kit.mjs
 * （256 逻辑坐标：一条开口圆角描边路径 + 一条内部中横，fill="none" stroke，round 线帽/拐角）。
 *
 * - tone="color"（默认）：内置 band 线性渐变（橙黄→橙→玫红→紫→蓝→亮蓝，陡斜轴）。
 *   渐变 id 用 React.useId() 生成，同一页面多实例不会 id 冲突。
 * - tone="mono"：不渲染渐变，描边用 currentColor，供节点行小尺寸/活动态跟随文本色。
 *
 * 尺寸默认 24×24，也可由 className 的 Tailwind 宽高类（或显式 width/height）覆盖。
 * 纯装饰用默认 aria-hidden；传入 aria-label 后自动作为可访问图形（role="img"）。
 */
export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, "fill"> {
  /** color＝彩色品牌带（默认）；mono＝currentColor 单色描边。 */
  tone?: "color" | "mono";
}

// 与 gen-kit.mjs 完全一致的 6 段色带（陡斜轴，userSpaceOnUse）。
const BRAND_BAND_STOPS: Array<{ offset: string; color: string }> = [
  { offset: "0", color: "#F7A81B" },
  { offset: "0.18", color: "#F5841F" },
  { offset: "0.38", color: "#E8447A" },
  { offset: "0.56", color: "#7B4CD8" },
  { offset: "0.78", color: "#2C7BE5" },
  { offset: "1", color: "#29B6F6" },
];

// 开口 G 外轮廓（stroke-width 26）与内部中横（stroke-width 11）。
const BRAND_G_PATH =
  "M 182 112 L 182 96 Q 182 74 160 74 L 96 74 Q 74 74 74 96 L 74 160 Q 74 182 96 182 L 160 182 Q 182 182 182 160 L 182 142 L 104 142";

export function BrandMark({ tone = "color", ...rest }: BrandMarkProps) {
  // React 18 useId：SSR/CSR 稳定且跨实例唯一，冒号在 id 与 url(#…) 引用中均合法。
  const rawId = useId();
  const gradientId = `gx-brand-band-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const paint = tone === "mono" ? "currentColor" : `url(#${gradientId})`;
  const labelled = rest["aria-label"] || rest["aria-labelledby"];
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 256 256"
      fill="none"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...rest}
    >
      {tone === "color" ? (
        <defs>
          <linearGradient
            id={gradientId}
            x1="76"
            y1="56"
            x2="174"
            y2="206"
            gradientUnits="userSpaceOnUse"
          >
            {BRAND_BAND_STOPS.map((s) => (
              <stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>
      ) : null}
      <path
        d={BRAND_G_PATH}
        stroke={paint}
        strokeWidth={26}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="98" y1="112" x2="146" y2="112" stroke={paint} strokeWidth={11} strokeLinecap="round" />
    </svg>
  );
}

/** 视图类型 → 图标 */
export const VIEW_ICON: Record<string, IconName> = {
  grid: "grid",
  gallery: "gallery",
  form: "form",
  detail: "detail",
  kanban: "kanban",
  calendar: "calendar",
  tree: "sitemap",
  gantt: "gantt",
  chart: "chart",
};

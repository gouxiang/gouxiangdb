import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(SRC, '..');
const BRAND = path.resolve(SRC, '../../../../../../branding/app-icon/svg/icon.svg');

const css = fs.readFileSync(path.join(SRC, 'shared.css'), 'utf8');

let logo = fs.readFileSync(BRAND, 'utf8').trim();
for (const g of ['paperk', 'pearlk', 'glossk', 'sheenk', 'bandk']) logo = logo.split(g).join('gxlogo-' + g);
logo = logo.replace('width="1024" height="1024"', 'width="32" height="32"');

const S = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
const I = {
  home: `<svg width="19" height="19" viewBox="0 0 24 24" ${S} stroke-width="1.75"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/></svg>`,
  db: `<svg width="19" height="19" viewBox="0 0 24 24" ${S} stroke-width="1.75"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>`,
  book: `<svg width="19" height="19" viewBox="0 0 24 24" ${S} stroke-width="1.75"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  users: `<svg width="19" height="19" viewBox="0 0 24 24" ${S} stroke-width="1.75"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="3.5"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>`,
  cog: `<svg width="19" height="19" viewBox="0 0 24 24" ${S} stroke-width="1.75"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  bell: `<svg width="17" height="17" viewBox="0 0 24 24" ${S} stroke-width="1.85"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
  help: `<svg width="17" height="17" viewBox="0 0 24 24" ${S} stroke-width="1.85"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.2 1-1.2 1.8v.4"/><circle cx="12" cy="17.2" r=".8" fill="currentColor" stroke="none"/></svg>`,
  search: `<svg width="13" height="13" viewBox="0 0 24 24" ${S} stroke-width="2"><path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"/><path d="M21 21l-4.35-4.35"/></svg>`,
  chev: `<svg width="13" height="13" viewBox="0 0 24 24" ${S} stroke-width="2" style="color:var(--ink-4)"><path d="M6 9l6 6 6-6"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  table: `<svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 10v10"/></svg>`,
  gear2: `<svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  chevL: `<svg width="15" height="15" viewBox="0 0 24 24" ${S} stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="1.8"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
  dotsV: `<svg width="13" height="13" viewBox="0 0 24 24" ${S} stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`,
  /* 菜单用图标（与行规格一致：14px / 1.8 描边） */
  m: {
    edit: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`,
    form: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8"/><path d="M8 13h8"/><path d="M8 17h4"/>`,
    copy: `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`,
    trash: `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>`,
    gear: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
    db: `<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`,
    book: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`,
  },
};

/** 菜单图标：14px / 1.8 描边，统一口径。 */
function menuIcon(name) {
  const d = I.m[name];
  if (!d) return `<svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="1.8"><circle cx="12" cy="12" r="8"/></svg>`;
  return `<svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="1.8">${d}</svg>`;
}

/* L1 = 数据库组 + 知识库组 + 底部管理区（与 PrimaryNav / nav-footer 真实结构一致） */
const RAIL = [
  { k: 'base1', label: '产品中心', icon: I.db, href: 'data-table.html', grp: 'base', grpLabel: '数据库' },
  { k: 'base2', label: '客户与合同', icon: I.db, href: '#', grp: 'base' },
  { k: 'base3', label: '运营指标', icon: I.db, href: '#', grp: 'base' },
  { k: 'kb1', label: '产品知识库', icon: I.book, href: '#', grp: 'kb', grpLabel: '知识库' },
  { k: 'kb2', label: '研发手册', icon: I.book, href: '#', grp: 'kb' },
];

/* 底部固定区（与 lib/nav-footer.ts 的 FOOTER_NAV_ITEMS 三项对齐；
   排序：通讯录 → 帮助中心 → 工作区设置，管理类入口压在最底） */
const RAIL_FOOT = [
  { k: 'contacts', label: '通讯录', icon: I.users },
  { k: 'help', label: '帮助中心', icon: I.help },
  { k: 'settings', label: '工作区设置', icon: I.cog },
];

function rail(active) {
  let out = '';
  let prev = null;
  for (const r of RAIL) {
    if (r.grp !== prev) {
      out += `      <div class="rail-grp"><span>${r.grpLabel}</span></div>\n`;
      prev = r.grp;
    }
    out += `      <a class="rail-item${r.k === active ? ' is-active' : ''}" href="${r.href}" title="${r.label}">
        <span class="rd">${r.icon}</span><span class="nm">${r.label}</span>
      </a>\n`;
  }
  return out;
}

function railFoot() {
  return RAIL_FOOT.map(
    f => `      <button class="rail-item rail-mini" title="${f.label}">
        <span class="rd">${f.icon}</span><span class="nm">${f.label}</span>
      </button>\n`,
  ).join('');
}

/** 表行「⋯」菜单：与 SecondaryNavTableOps.rowMenuItems 逐项对齐（真实能力，无发明项）。 */
const TABLE_ROW_MENU = [
  { icon: 'edit', label: '重命名' },
  { icon: 'form', label: '编辑表单', desc: '进入表单设计器' },
  { icon: 'copy', label: '复制表（含数据）' },
  { icon: 'copy', label: '复制表（不含数据）' },
  { icon: 'trash', label: '清空数据', danger: true, sep: true },
  { icon: 'trash', label: '删除表', danger: true },
];

function shell({ active, crumb, l2, body }) {
  const items = l2.items.map((it, i) => {
    const menu =
      it.menu === false
        ? ''
        : `        <button class="row-more" data-menu="t${i}" aria-label="${it.name} 表操作菜单" aria-haspopup="menu">
          <svg width="13" height="13" viewBox="0 0 24 24" ${S} stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
        <div class="pop" data-menu-panel="t${i}" style="right:4px; top:30px; width:196px;">
${TABLE_ROW_MENU.map(m => {
  const d = m.desc ? `<span class="sub">${m.desc}</span>` : '';
  return `          <button class="mi${m.danger ? ' danger' : ''}">${menuIcon(m.icon)}<span>${m.label}</span>${d}</button>`;
}).join('\n')}
        </div>\n`;
    return `      <div class="l2-row">
      <a class="l2-item${it.active ? ' is-active' : ''}" href="${it.href || '#'}" title="${it.name}">
        <span class="ico">${it.icon || I.table}</span><span class="nm">${it.name}</span>${it.cnt ? `<span class="cnt">${it.cnt}</span>` : ''}
      </a>
${menu}    </div>`;
  }).join('\n');

  const foot = (l2.foot || []).map(f => `      <a class="l2-item sub" href="#" title="${f.name}">${f.icon}<span class="nm">${f.name}</span></a>`).join('\n');

  return `<div class="app" id="app">
  <aside class="rail">
    <div class="rail-mark">${logo}</div>
    <button class="rail-create" id="createLib" title="新建库">${I.plus}<span>新建库</span></button>
    <nav class="rail-nav">
${rail(active)}    </nav>
    <div class="rail-foot">
${railFoot()}    </div>
  </aside>

  <aside class="l2" id="l2Panel">
    <div class="l2-inner">
      <div class="l2-h">
        <span class="l2-ico">${I.table}</span>
        <span class="l2-title">${l2.title}</span>
        <span class="tag ${l2.tagClass || 'tag-gray'}">${l2.tag}</span>
        <button class="icon-btn l2-act" id="baseMenu" data-menu="baseMenu" title="重命名库 / 库设置">
          <svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
        <div class="pop" data-menu-panel="baseMenu" style="right:6px; top:40px; width:192px;">
          <button class="mi">${menuIcon('edit')}<span>重命名库</span></button>
          <button class="mi">${menuIcon('gear')}<span>库设置</span></button>
          <div class="pop-sep"></div>
          <button class="mi danger">${menuIcon('trash')}<span>删除库</span></button>
        </div>
      </div>
      ${l2.search ? `<div class="l2-search">${I.search}<span>${l2.search}</span></div>` : ''}
      <div class="l2-new">
        <button class="l2-new-btn" id="newTableBtn" title="新建数据表">${I.plus}<span>新建数据表</span></button>
        <div class="l2-new-in" id="newTableIn" style="display:none">
          <input class="l2-new-input" id="newTableInput" placeholder="表名（Enter 创建 / Esc 取消）" />
        </div>
      </div>
      <div class="l2-list">
${items}
      </div>
      <div class="l2-foot">
${foot}
      </div>
    </div>
  </aside>

  <button class="l2-toggle" id="l2Toggle" aria-expanded="true" aria-controls="l2Panel" title="收起二级导航">${I.chevL}</button>

  <!-- 建库弹窗（真实：CreateLibraryModal，名称 + 库类型二选一） -->
  <div class="mask" id="createMask"></div>
  <div class="modal" id="createModal" role="dialog" aria-modal="true" aria-label="新建库">
    <div class="modal-h"><span class="modal-t">新建库</span>
      <button class="modal-x" id="createClose" aria-label="关闭">
        <svg width="14" height="14" viewBox="0 0 24 24" ${S} stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="modal-b">
      <div>
        <div class="fld-l">名称</div>
        <div class="inp">库名称，如：客户管理 / 产品资料库</div>
      </div>
      <div>
        <div class="fld-l">库类型</div>
        <div class="typ">
          <button class="typ-c is-on" type="button">${menuIcon('db')}<b>智能数据库</b><span>表格 / 视图 / 字段</span></button>
          <button class="typ-c" type="button">${menuIcon('book')}<b>知识库</b><span>文档 / 画布</span></button>
        </div>
      </div>
    </div>
    <div class="modal-f">
      <button class="btn btn-sm" id="createCancel">取消</button>
      <button class="btn btn-primary btn-sm">创建</button>
    </div>
  </div>

  <div class="main">
    <header class="topbar">
      <div class="crumb"><span class="c1">${crumb[0]}</span><span class="sep">/</span><span class="c2">${crumb[1]}</span></div>
      <button class="cmd">${I.search}<span class="ph">搜索数据表、文档、成员…</span><span class="kbd">⌘K</span></button>
      <div class="top-right">
        <button class="icon-btn" title="通知">${I.bell}<span class="dot"></span></button>
        <button class="icon-btn" title="帮助">${I.help}</button>
        <div class="vline"></div>
        <div class="who"><span class="av av-md av-a">戴</span><span class="nm">戴静</span>${I.chev}</div>
      </div>
    </header>
    <div class="scroll">
${body}
    </div>
  </div>
</div>
<div class="proto-note">v6 · 企业工作台 · 严格对齐真实功能入口</div>
<script>
  /* L2 收起 / 展开：整栏收起（v2 手感），箭头骑在边界中点 */
  (function () {
    var app = document.getElementById('app');
    var btn = document.getElementById('l2Toggle');
    if (!app || !btn) return;
    function sync() {
      var c = app.classList.contains('l2-collapsed');
      btn.setAttribute('aria-expanded', String(!c));
      btn.title = c ? '展开二级导航' : '收起二级导航';
    }
    sync();
    btn.addEventListener('click', function () {
      app.classList.toggle('l2-collapsed');
      sync();
    });
  })();

  /* 建库弹窗（真实：CreateLibraryModal —— 名称 + 库类型二选一） */
  (function () {
    var openers = [document.getElementById('createLib')].filter(Boolean);
    var mask = document.getElementById('createMask');
    var modal = document.getElementById('createModal');
    if (!mask || !modal) return;
    function setOpen(on) {
      mask.classList.toggle('is-open', on);
      modal.classList.toggle('is-open', on);
    }
    openers.forEach(function (b) { b.addEventListener('click', function () { setOpen(true); }); });
    ['createClose', 'createCancel'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', function () { setOpen(false); });
    });
    mask.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
  })();

  /* 新建数据表：点按钮内联展开输入框（真实：SecondaryNavTableOps.panelNode） */
  (function () {
    var btn = document.getElementById('newTableBtn');
    var box = document.getElementById('newTableIn');
    var input = document.getElementById('newTableInput');
    if (!btn || !box || !input) return;
    function open(on) {
      btn.style.display = on ? 'none' : '';
      box.style.display = on ? '' : 'none';
      if (on) input.focus();
    }
    btn.addEventListener('click', function () { open(true); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && input.value.trim()) { input.value = ''; open(false); }
      if (e.key === 'Escape') { input.value = ''; open(false); }
    });
    document.addEventListener('click', function (e) {
      if (box.style.display === 'none') return;
      if (!box.contains(e.target) && e.target !== btn) { input.value = ''; open(false); }
    });
  })();

  /* 库级「⋯」菜单：重命名库 / 库设置 / 删除库 */
  (function () {
    var btn = document.getElementById('baseMenu');
    var panel = document.querySelector('[data-menu-panel="baseMenu"]');
    if (!btn || !panel) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('is-open');
    });
    document.addEventListener('click', function () { panel.classList.remove('is-open'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') panel.classList.remove('is-open');
    });
  })();
</script>`;
}

function page({ title, active, crumb, l2, part, out }) {
  const body = fs.readFileSync(path.join(SRC, part), 'utf8');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
${shell({ active, crumb, l2, body })}
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT, out), html, 'utf8');
  return `${out} ${(html.length / 1024).toFixed(1)}KB`;
}

const L2_BASE = {
  title: '产品中心', tag: '库', actTitle: '新建数据表',
  search: '搜索数据表',
  items: [
    { name: '需求池', cnt: '128', active: true, href: 'data-table.html' },
    { name: '迭代计划', cnt: '24' },
    { name: '缺陷跟踪', cnt: '61' },
    { name: '客户档案', cnt: '78' },
    { name: '内容排期', cnt: '32' },
  ],
  // 真实：列表末尾固定「回收站」（/base/:id/trash）；库设置在面板头「⋯」里
  foot: [{ name: '回收站', icon: I.trash }],
};

console.log(page({ title: '构想工作台 · 需求池', active: 'base1', crumb: ['产品中心', '需求池'], l2: L2_BASE, part: 'table.part.html', out: 'data-table.html' }));

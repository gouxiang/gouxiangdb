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
};

/* L1 = 工作台 + 各库 + 各知识库 + 通讯录（与产品真实结构一致；消息/日程尚未开发，不上轨道） */
const RAIL = [
  { k: 'home', label: '工作台', icon: I.home, href: 'workbench.html', grp: 'sys' },
  { k: 'base1', label: '产品中心', icon: I.db, href: 'data-table.html', grp: 'base' },
  { k: 'base2', label: '客户与合同', icon: I.db, href: '#', grp: 'base' },
  { k: 'base3', label: '运营指标', icon: I.db, href: '#', grp: 'base' },
  { k: 'kb1', label: '产品知识库', icon: I.book, href: '#', grp: 'kb' },
  { k: 'kb2', label: '研发手册', icon: I.book, href: '#', grp: 'kb' },
  { k: 'contacts', label: '通讯录', icon: I.users, href: '#', grp: 'end' },
];

function rail(active) {
  let out = '';
  let prev = null;
  for (const r of RAIL) {
    if (prev && r.grp !== prev) out += '      <div class="rail-sep"></div>\n';
    out += `      <a class="rail-item${r.k === active ? ' is-active' : ''}" href="${r.href}">${r.icon}<span>${r.label}</span></a>\n`;
    prev = r.grp;
  }
  return out;
}

function shell({ active, crumb, l2, body }) {
  const items = l2.items.map(it => `      <a class="l2-item${it.active ? ' is-active' : ''}" href="${it.href || '#'}" title="${it.name}">
        <span class="ico">${it.icon || I.table}</span><span class="nm">${it.name}</span>${it.cnt ? `<span class="cnt">${it.cnt}</span>` : ''}
      </a>`).join('\n');
  const foot = (l2.foot || []).map(f => `      <a class="l2-item sub" href="#" title="${f.name}">${f.icon}<span class="nm">${f.name}</span></a>`).join('\n');

  return `<div class="app" id="app">
  <aside class="rail">
    <div class="rail-mark">${logo}</div>
    <nav class="rail-nav">
${rail(active)}    </nav>
    <div class="rail-foot">
      <button class="rail-item" title="设置">${I.cog}<span>设置</span></button>
    </div>
  </aside>

  <aside class="l2" id="l2Panel">
    <div class="l2-inner">
      <div class="l2-h">
        <span class="l2-title">${l2.title}</span>
        <span class="tag ${l2.tagClass || 'tag-gray'}">${l2.tag}</span>
        <button class="icon-btn l2-act" title="${l2.actTitle || '新建'}">${I.plus}</button>
      </div>
      ${l2.search ? `<div class="l2-search">${I.search}<span>${l2.search}</span></div>` : ''}
      <div class="l2-list">
${items}
      </div>
      <div class="l2-foot">
${foot}
      </div>
    </div>
  </aside>

  <button class="l2-toggle" id="l2Toggle" aria-expanded="true" aria-controls="l2Panel" title="收起二级导航">${I.chevL}</button>

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
<div class="proto-note">v6 · 企业工作台（L1 工作台/库/知识库 + L2 库内清单）</div>
<script>
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

const L2_WORKBENCH = {
  title: '个人工作台', tag: '规划中', tagClass: 'tag-warm', actTitle: '工作台设置',
  items: [
    { name: '概览', active: true, href: 'workbench.html' },
    { name: '我负责的记录', cnt: '24' },
    { name: '我的收藏', cnt: '8' },
    { name: '最近访问' },
  ],
  foot: [{ name: '工作台设置', icon: I.gear2 }],
};

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
  foot: [{ name: '库设置', icon: I.gear2 }, { name: '回收站', icon: I.trash }],
};

console.log(page({ title: '构想工作台 · 工作台', active: 'home', crumb: ['工作台', '概览'], l2: L2_WORKBENCH, part: 'workbench.part.html', out: 'workbench.html' }));
console.log(page({ title: '构想工作台 · 需求池', active: 'base1', crumb: ['产品中心', '需求池'], l2: L2_BASE, part: 'table.part.html', out: 'data-table.html' }));

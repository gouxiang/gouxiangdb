import { chromium } from '/Users/daijing/Desktop/GouXiangDB/node_modules/.pnpm/@playwright+test@1.62.1/node_modules/playwright/index.mjs';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const BASE_URL = 'http://localhost:5173';
const API_URL = 'http://localhost:3001';
const SCREENSHOT_DIR = '/Users/daijing/Desktop/GouXiangDB/docs/acceptance/screenshots';
const REPORT_DIR = '/Users/daijing/Desktop/GouXiangDB/docs/acceptance';

const userDataDir = `/tmp/gx-acceptance-${randomUUID()}`;
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const logs = [];
let authPayload = null;
let injectAuthEnabled = false;

const ctx = await chromium.launchPersistentContext(userDataDir, {
  viewport: { width: 1440, height: 900 },
  args: ['--disable-features=PasswordManager'],
});

const page = ctx.pages()[0] || (await ctx.newPage());

page.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text(), url: page.url() }));
page.on('pageerror', (err) => logs.push({ type: 'pageerror', text: err.message, url: page.url() }));

await page.addInitScript(() => {
  window.confirm = () => true;
  window.alert = () => {};
  window.print = () => {};
});

async function injectAuth() {
  if (!authPayload) return;
  await page.evaluate((p) => {
    localStorage.setItem('gx-auth', JSON.stringify({ state: { token: p.token, user: p.user }, version: 0 }));
  }, authPayload);
}

async function apiLogin(password) {
  const r = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@gx.dev', password }),
  });
  const data = await r.json();
  if (!data.token) throw new Error('API login failed: ' + JSON.stringify(data));
  return data;
}

const RESET_PASSWORD = 'GxAcceptP$w9-UiStage5';
const FINAL_PASSWORD = 'GxAcceptFinalP$w9-Ui';

async function resetTestAccount() {
  const db = path.resolve('/Users/daijing/Desktop/GouXiangDB/apps/api/prisma/dev.db');
  const cmd = `cd /Users/daijing/Desktop/GouXiangDB/apps/api && DATABASE_URL="file:${db}" node dist/init-admin.js --reset --email test@gx.dev --password '${RESET_PASSWORD}'`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 20000 });
    logs.push({ type: 'info', text: out.trim(), url: '' });
  } catch (e) {
    logs.push({ type: 'warn', text: 'init-admin reset failed: ' + e.stderr || e.message, url: '' });
  }
}

async function ensureAuth() {
  await resetTestAccount();
  let data = await apiLogin(RESET_PASSWORD);
  if (data.user?.mustChangePassword) {
    const ch = await fetch(`${API_URL}/api/auth/me/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
      body: JSON.stringify({ currentPassword: RESET_PASSWORD, newPassword: FINAL_PASSWORD }),
    });
    if (!ch.ok) throw new Error('API change-password failed: ' + (await ch.text()));
    data = await apiLogin(FINAL_PASSWORD);
  }
  authPayload = { token: data.token, user: data.user };
  injectAuthEnabled = true;
  await injectAuth();
}

async function nav(path, options = {}) {
  const waitFor = options.waitFor ?? 'networkidle';
  const inject = options.inject ?? injectAuthEnabled;
  try {
    if (inject) await injectAuth();
    await page.goto(BASE_URL + path, { waitUntil: waitFor, timeout: 20000 });
  } catch (e) {
    logs.push({ type: 'navwarn', text: e.message, url: BASE_URL + path });
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(600);
}

async function ss(name) {
  const p = path.join(SCREENSHOT_DIR, `q5-${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  logs.push({ type: 'screenshot', text: `q5-${name}.png`, url: page.url() });
  return p;
}

async function clickByText(text, options = {}) {
  const loc = page.locator('button, a, [role="button"]', { hasText: new RegExp(text) }).first();
  if (await loc.count()) {
    await loc.click(options);
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

async function dismissJoinGate() {
  const gate = page.locator('button', { hasText: '进入 Base' }).first();
  if (await gate.count()) {
    await gate.click();
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

async function login() {
  await nav('/login', { waitFor: 'load', inject: false });
  await ss('01-login');
  await ensureAuth();
  // Visit change-password page visually to verify it renders, then leave
  await nav('/change-password', { waitFor: 'load' });
  await ss('02-change-password');
  // root redirect after auth
  await nav('/', { waitFor: 'networkidle' });
  await ss('03-root-redirect');
}

async function shellPages() {
  // Base/table main
  await nav('/base/cmtxuttqp001a607owsuxw3gy/table/cmtxuttqv001e607oiaazb0pj/view/cmtxuttr1001q607o79pmm5ti');
  await dismissJoinGate();
  await ss('04-table-main');

  // L1 collapse / expand (tolerate missing button)
  try {
    const collapseBtn = page.locator('button', { hasText: '收起导航' }).first();
    await collapseBtn.waitFor({ timeout: 5000 });
    await collapseBtn.click();
    await page.waitForTimeout(800);
    await ss('05-l1-collapsed');
    const expandBtn = page.locator('button', { hasText: '展开导航' }).first();
    if (await expandBtn.count()) {
      await expandBtn.click();
      await page.waitForTimeout(800);
      await ss('06-l1-expanded');
    }
  } catch (e) {
    logs.push({ type: 'warn', text: 'L1 collapse not exercised: ' + e.message, url: page.url() });
  }

  // Base settings
  await nav('/base/cmtxuttqp001a607owsuxw3gy/settings');
  await ss('07-base-settings');

  // Base trash
  await nav('/base/cmtxuttqp001a607owsuxw3gy/trash');
  await ss('08-base-trash');

  // Base erd
  await nav('/base/cmtxuttqp001a607owsuxw3gy/erd');
  await ss('09-base-erd');

  // Table 2
  await nav('/base/cmtxuttqp001a607owsuxw3gy/table/cmtxuv0vk001w607or040peaf');
  await dismissJoinGate();
  await ss('10-table2');

  // KB list
  await nav('/kb');
  await ss('11-kb-list');

  // KB home
  await nav('/kb/cmtxr0jok0001607owi2oydgd');
  await ss('12-kb-home');

  // Doc editor
  await nav('/kb/cmtxr0jok0001607owi2oydgd/doc/cmtxr71h1000l607okdoth5bu');
  await ss('13-kb-doc');

  // Canvas editor
  await nav('/kb/cmtxr0jok0001607owi2oydgd/canvas/cmtxr44jh000d607ob50o741b');
  await ss('14-kb-canvas');

  // KB trash
  await nav('/kb/cmtxr0jok0001607owi2oydgd/trash');
  await ss('15-kb-trash');

  // KB settings
  await nav('/kb/cmtxr0jok0001607owi2oydgd/settings');
  await ss('16-kb-settings');

  // Workspace contacts
  await nav('/workspace/contacts');
  await ss('17-ws-contacts');

  // Workspace authz
  await nav('/workspace/authz');
  await ss('18-ws-authz');

  // Workspace settings subpages
  const wsSettings = [
    ['general', '通用'],
    ['contacts', '通讯录'],
    ['nav', '导航编排'],
    ['search', '语义检索'],
    ['mcp', 'MCP 接入'],
    ['assets', '资产'],
  ];
  for (const [slug, label] of wsSettings) {
    await nav(`/workspace/settings/${slug}`);
    await ss(`19-ws-settings-${slug}`);
  }
}

async function closeOverlay() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

async function interactions() {
  await nav('/base/cmtxuttqp001a607owsuxw3gy/table/cmtxuttqv001e607oiaazb0pj/view/cmtxuttr1001q607o79pmm5ti');
  await dismissJoinGate();

  // Row-end three dots hover visibility
  try {
    const firstRow = page.locator('[role="row"], tbody tr, .data-row').first();
    if (await firstRow.count()) {
      await firstRow.hover();
      await page.waitForTimeout(300);
      await ss('20-row-hover-three-dots');
    }
  } catch (e) { logs.push({ type: 'warn', text: 'row hover: ' + e.message, url: page.url() }); }

  // Create record
  try {
    const newBtn = page.locator('button', { hasText: '新建记录' }).first();
    if (await newBtn.count()) {
      await newBtn.click();
      await page.waitForTimeout(1200);
      await ss('21-new-record');
      await closeOverlay();
    }
  } catch (e) { logs.push({ type: 'warn', text: 'new record: ' + e.message, url: page.url() }); }

  // Edit first cell
  try {
    const firstCell = page.locator('td, [role="cell"]').first();
    if (await firstCell.count()) {
      await firstCell.dblclick();
      await page.waitForTimeout(300);
      await ss('22-inline-edit');
      await closeOverlay();
    }
  } catch (e) { logs.push({ type: 'warn', text: 'inline edit: ' + e.message, url: page.url() }); }

  // Delete first row via row menu
  try {
    const row = page.locator('tbody tr, [role="row"]').nth(1);
    if (await row.count()) {
      await row.hover();
      await page.waitForTimeout(200);
      const menuBtn = row.locator('button').last();
      if (await menuBtn.count()) await menuBtn.click();
      await page.waitForTimeout(400);
      await ss('23-row-menu');
      const del = page.locator('[role="menuitem"], button, a', { hasText: '删除' }).first();
      if (await del.count()) await del.click();
      await page.waitForTimeout(1200);
      await ss('24-after-delete-toast');
      // try undo
      const undo = page.locator('button, [role="button"]', { hasText: '撤销' }).first();
      if (await undo.count()) {
        await undo.click();
        await page.waitForTimeout(1000);
        await ss('25-after-undo');
      }
      await closeOverlay();
    }
  } catch (e) { logs.push({ type: 'warn', text: 'delete row: ' + e.message, url: page.url() }); }

  // Import wizard
  try {
    await closeOverlay();
    const importBtn = page.locator('button', { hasText: /^导入$/ }).first();
    if (await importBtn.count()) {
      await importBtn.click();
      await page.waitForTimeout(800);
      await ss('26-import-step1');
      const next = page.locator('button', { hasText: '下一步' }).first();
      if (await next.count()) {
        await next.click();
        await page.waitForTimeout(400);
        await ss('27-import-step2');
      }
      await closeOverlay();
    }
  } catch (e) { logs.push({ type: 'warn', text: 'import wizard: ' + e.message, url: page.url() }); }

  // Export dialog
  try {
    await closeOverlay();
    const exportBtn = page.locator('button', { hasText: /^导出$/ }).first();
    if (await exportBtn.count()) {
      await exportBtn.click();
      await page.waitForTimeout(800);
      await ss('28-export-dialog');
      await closeOverlay();
    }
  } catch (e) { logs.push({ type: 'warn', text: 'export dialog: ' + e.message, url: page.url() }); }

  // Bulk select
  try {
    await nav('/base/cmtxuttqp001a607owsuxw3gy/table/cmtxuttqv001e607oiaazb0pj/view/cmtxuttr1001q607o79pmm5ti');
    await dismissJoinGate();
    const headerCheckbox = page.locator('thead input[type="checkbox"], th input[type="checkbox"]').first();
    if (await headerCheckbox.count()) {
      await headerCheckbox.click();
      await page.waitForTimeout(600);
      await ss('29-bulk-bar');
      const bulkDel = page.locator('button', { hasText: /删除/ }).first();
      if (await bulkDel.count()) await bulkDel.click();
      await page.waitForTimeout(800);
      await ss('30-bulk-delete-confirm');
      await closeOverlay();
    }
  } catch (e) { logs.push({ type: 'warn', text: 'bulk delete: ' + e.message, url: page.url() }); }

  // Search ⌘K
  try {
    await closeOverlay();
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(800);
    await ss('31-search-cmdk');
    await closeOverlay();
  } catch (e) { logs.push({ type: 'warn', text: 'cmdk search: ' + e.message, url: page.url() }); }
}

async function kbInteractions() {
  try {
    await nav('/kb/cmtxr0jok0001607owi2oydgd');
    // New doc
    const newDoc = page.locator('button', { hasText: /新建文档/ }).first();
    if (await newDoc.count()) {
      await newDoc.click();
      await page.waitForTimeout(1200);
      await ss('32-kb-new-doc');
      const title = page.locator('input[placeholder*="标题"], [contenteditable="true"]').first();
      if (await title.count()) {
        await title.fill('验收测试文档');
        await page.waitForTimeout(300);
      }
      const save = page.locator('button', { hasText: '保存' }).first();
      if (await save.count()) {
        await save.click();
        await page.waitForTimeout(1000);
        await ss('33-kb-saved-doc');
      }
      await closeOverlay();
    }

    // Delete the newly created doc
    const docRow = page.locator('a, button', { hasText: '验收测试文档' }).first();
    if (await docRow.count()) {
      const row = docRow.locator('xpath=ancestor::tr | ancestor::div[contains(@class,"row")]').first();
      if (await row.count()) {
        await row.hover();
        await page.waitForTimeout(200);
        const menu = row.locator('button').last();
        if (await menu.count()) await menu.click();
        await page.waitForTimeout(300);
        const del = page.locator('[role="menuitem"], button, a', { hasText: '删除' }).first();
        if (await del.count()) await del.click();
        await page.waitForTimeout(1200);
        await ss('34-kb-delete-toast');
        await closeOverlay();
      }
    }

    // KB trash restore
    await nav('/kb/cmtxr0jok0001607owi2oydgd/trash');
    await ss('35-kb-trash-with-doc');
    const restore = page.locator('button', { hasText: '恢复' }).first();
    if (await restore.count()) {
      await restore.click();
      await page.waitForTimeout(1000);
      await ss('36-kb-trash-after-restore');
    }
  } catch (e) {
    logs.push({ type: 'warn', text: 'kb interactions: ' + e.message, url: page.url() });
  }
}

async function breakpoints() {
  const sizes = [
    [1440, 900],
    [1280, 900],
    [1100, 900],
    [900, 900],
    [600, 900],
  ];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await nav('/base/cmtxuttqp001a607owsuxw3gy/table/cmtxuttqv001e607oiaazb0pj/view/cmtxuttr1001q607o79pmm5ti');
    await dismissJoinGate();
    await page.waitForTimeout(700);
    await ss(`bp-${w}x${h}`);
  }
  // restore
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function runSafely(fn, label) {
  try { await fn(); } catch (e) { logs.push({ type: 'warn', text: `${label} failed: ${e.message}`, url: page.url() }); }
}

async function main() {
  await login();
  await runSafely(shellPages, 'shellPages');
  await runSafely(interactions, 'interactions');
  await runSafely(kbInteractions, 'kbInteractions');
  await runSafely(breakpoints, 'breakpoints');

  // public pages (logged out context)
  const publicCtx = await ctx.browser().newContext({ viewport: { width: 1440, height: 900 } });
  const publicPage = await publicCtx.newPage();
  publicPage.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text(), url: publicPage.url() }));
  publicPage.on('pageerror', (err) => logs.push({ type: 'pageerror', text: err.message, url: publicPage.url() }));
  await publicPage.goto(`${BASE_URL}/login`, { waitUntil: 'load' });
  await publicPage.waitForTimeout(600);
  await publicPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'q5-pub-login.png'), fullPage: false });

  // Try join/invite/share with dummy tokens - these will likely show error/invalid token pages
  for (const [name, pathSeg] of [
    ['join', '/join/invalid-token'],
    ['invite', '/invite/invalid-token'],
    ['share', '/s/invalid-token'],
  ]) {
    await publicPage.goto(BASE_URL + pathSeg, { waitUntil: 'load' });
    await publicPage.waitForTimeout(600);
    await publicPage.screenshot({ path: path.join(SCREENSHOT_DIR, `q5-pub-${name}.png`), fullPage: false });
  }

  await publicCtx.close();

  // Save logs
  writeFileSync(path.join(REPORT_DIR, 'acceptance-logs.json'), JSON.stringify(logs, null, 2));
  await ctx.close();
  console.log('acceptance run complete');
}

main().catch((e) => {
  console.error(e);
  writeFileSync(path.join(REPORT_DIR, 'acceptance-error.json'), JSON.stringify({ error: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});

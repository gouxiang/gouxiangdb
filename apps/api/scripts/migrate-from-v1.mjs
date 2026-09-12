#!/usr/bin/env node
// scripts/migrate-from-v1.mjs
// 把 v1 GouXiangDB (macOS 原生 SQLite) 数据迁移到 v2 (Hono+Prisma+SQLite API)。
//
// 用法：
//   node scripts/migrate-from-v1.mjs [options]
//   # 默认读 ~/Library/Application Support/GouXiangDB/data.gxdb
//   # 默认连 http://127.0.0.1:3001
//   # 默认复用环境变量 V2_EMAIL / V2_PASSWORD（建议首次创建 v2 账号用 signup 子命令）
//
// 子命令：
//   signup <email> <password> <displayName>   —— 在 v2 注册新账号（拿到 token 后用 export V2_TOKEN）
//   run [--email X --password Y --db PATH --api URL --base-name "数据迁移" --dry-run]
//
// 实现要点：
//   - v1 records 走物理列 c_<fieldId>；v2 走 records.fields JSON Map（按 field id 索引）
//   - v1 字段元数据在 field 表（uidt）；v2 走 FieldMeta 表（type）—— 用 uidt→type 映射转换
//   - v1 system 字段（ID/CreatedTime/...）v2 已自动生成，跳过即可
//   - v1 link_row（link_field_id/parent_row_id/child_row_id/ord）→ v2 同结构，
//     写入走 PATCH /api/records/:id（links 字段值 = [{recordId}]）
//   - v1 view.config 字段名（fields/groups/colorConditions/...）映射到 v2（hiddenFieldIds/groupByFieldId/rowColor/...）

import Database from "better-sqlite3";
import process from "node:process";

// ============ CLI 参数 ============

function parseArgs(argv) {
  const args = { subcommand: "run" };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "signup") {
      args.subcommand = "signup";
      args.email = argv[++i];
      args.password = argv[++i];
      args.displayName = argv[++i];
    } else if (a === "run") {
      args.subcommand = "run";
    } else if (a === "--email") args.email = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--api") args.api = argv[++i];
    else if (a === "--base-name") args.baseName = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`未知参数：${a}`);
    i++;
  }
  return args;
}

function help() {
  console.log(`v1 → v2 数据迁移工具

用法：
  node scripts/migrate-from-v1.mjs signup <email> <password> <displayName>
  node scripts/migrate-from-v1.mjs run [options]

run 选项：
  --email       v2 账号邮箱（也可用环境变量 V2_EMAIL）
  --password    v2 账号密码（也可用环境变量 V2_PASSWORD）
  --token       已登录的 JWT（也可用环境变量 V2_TOKEN，二选一）
  --db          v1 数据库路径（默认 ~/Library/Application Support/GouXiangDB/data.gxdb）
  --api         v2 API 地址（默认 http://127.0.0.1:3001）
  --base-name   v2 新建 base 的名称（默认 "v1 迁移数据"）
  --dry-run     只读 v1 数据并打印计划，不写 v2
`);
}

// ============ v1 uidt → v2 type 映射 ============
// 参考：
//   v1: packages/shared-types/src/fields.ts FIELD_TYPES
//   v2 同上
const V1_TO_V2_TYPE = {
  ID: null, // v2 自动生成，跳过
  SingleLineText: "singleLineText",
  LongText: "longText",
  RichText: "richText",
  Number: "number",
  Currency: "currency",
  Percent: "percent",
  Duration: "duration",
  Date: "date",
  DateTime: "datetime",
  Checkbox: "checkbox",
  SingleSelect: "singleSelect",
  MultiSelect: "multiSelect",
  Email: "email",
  URL: "url",
  Phone: "phone",
  Rating: "rating",
  AutoNumber: "autoNumber",
  JSON: "json",
  Attachment: "attachment",
  Links: "links",
  Lookup: "lookup",
  Rollup: "rollup",
  Count: "count",
  Formula: "formula",
  // 系统字段：v2 自动生成，跳过
  CreatedTime: null,
  LastModifiedTime: null,
  CreatedBy: null,
  LastModifiedBy: null,
  // v1 协作者字段 v2 没有，留 null 提示
  Collaborator: null,
  User: null,
};

// v1 view.vtype → v2 view.type
const V1_TO_V2_VIEWTYPE = {
  grid: "grid",
  gallery: "gallery",
  kanban: "kanban",
  // timeline/list 在 v2 没直接对应，统一落到 detail 视图（保留分组等核心信息）
  timeline: "detail",
  list: "detail",
};

// ============ HTTP 客户端 ============

class V2Client {
  constructor(api, token) {
    this.api = api.replace(/\/+$/, "");
    this.token = token;
  }

  async req(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${method} ${path}\n${typeof data === "string" ? data : JSON.stringify(data)}`);
    }
    return data;
  }

  signup(email, password, displayName) {
    return this.req("POST", "/api/auth/signup", { email, password, displayName });
  }
  login(email, password) {
    return this.req("POST", "/api/auth/login", { email, password });
  }
  createBase(body) { return this.req("POST", "/api/bases", body); }
  createTable(baseId, body) { return this.req("POST", `/api/tables?baseId=${baseId}`, body); }
  createField(tableId, body) { return this.req("POST", `/api/fields?tableId=${tableId}`, body); }
  patchField(fieldId, body) { return this.req("PATCH", `/api/fields/${fieldId}`, body); }
  createView(tableId, body) { return this.req("POST", `/api/views?tableId=${tableId}`, body); }
  createRecord(tableId, body) { return this.req("POST", `/api/records?tableId=${tableId}`, body); }
  patchRecord(recordId, body) { return this.req("PATCH", `/api/records/${recordId}`, body); }
}

// ============ v1 数据读取 ============

function readV1(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const bases = db.prepare("SELECT * FROM base WHERE deleted = 0 ORDER BY ord").all();
  const tables = db.prepare("SELECT * FROM gx_table WHERE deleted = 0 ORDER BY ord").all();
  const tableIds = tables.map((t) => t.id);
  const fields = tableIds.length > 0
    ? db.prepare(
        `SELECT * FROM field WHERE table_id IN (${tableIds.map(() => "?").join(",")}) AND deleted = 0 ORDER BY table_id, ord`,
      ).all(...tableIds)
    : [];
  const views = tableIds.length > 0
    ? db.prepare(
        `SELECT * FROM view WHERE table_id IN (${tableIds.map(() => "?").join(",")}) AND deleted = 0 ORDER BY table_id, ord`,
      ).all(...tableIds)
    : [];

  // 按表读 records（物理表）
  const records = {};
  for (const t of tables) {
    const tbl = db.prepare(`SELECT * FROM ${t.physical} WHERE deleted = 0 ORDER BY created_at`).all();
    records[t.id] = tbl;
  }

  // link_row 全量（按 linkFieldId 在 v2 字段已建好后分批 PATCH）
  const linkRows = db.prepare("SELECT * FROM link_row").all();

  db.close();
  return { bases, tables, fields, views, records, linkRows };
}

// ============ 字段转换 ============

function mapFieldCreate(v1Field, tableIdMap, fieldIdMap) {
  const v2Type = V1_TO_V2_TYPE[v1Field.uidt];
  if (!v2Type) {
    return { skip: true, reason: `v1 uidt="${v1Field.uidt}" 无 v2 对应类型` };
  }

  let meta = {};
  try { meta = JSON.parse(v1Field.meta_json || "{}"); } catch {}

  const body = {
    name: v1Field.title,
    type: v2Type,
  };

  if (v2Type === "number") {
    if (typeof meta.precision === "number") body.precision = meta.precision;
  }

  if (v2Type === "links") {
    // v1 relatedTableId 是 v1 表 id；v2 用 v1→v2 表 id 映射
    const newRelated = tableIdMap.get(meta.relatedTableId);
    if (!newRelated) {
      return { skip: true, reason: `links 字段 relatedTableId 未在映射表` };
    }
    body.relatedTableId = newRelated;
    body.relationKind = meta.relationType === "bt" ? "bt"
                      : meta.relationType === "hm" ? "hm"
                      : "mm";
    if (typeof meta.linkMultiple === "boolean") {
      // v1 linkMultiple=false → bt（单值），否则保留原 relationKind
      if (!meta.linkMultiple && body.relationKind !== "bt") {
        body.relationKind = "bt";
      }
    }
    if (meta.isReverse) body.isReverse = true;
    if (meta.linkDisplayFieldId) {
      const newDisplay = fieldIdMap.get(meta.linkDisplayFieldId);
      if (newDisplay) body.linkDisplayFieldId = newDisplay;
    }
  }

  if (v2Type === "rollup") {
    const newLink = fieldIdMap.get(meta.linkFieldId);
    if (!newLink) return { skip: true, reason: `rollup 字段 linkFieldId 未在映射表` };
    body.linkFieldId = newLink;
    body.rollupFunction = meta.rollupFn || "sum";
    if (meta.relatedTableId) {
      const newRelated = tableIdMap.get(meta.relatedTableId);
      if (newRelated) body.relatedTableId = newRelated;
    }
  }

  if (v2Type === "formula") {
    body.formula = meta.formula || "";
  }

  return { body, v2Type };
}

// ============ 视图配置转换 ============

function mapViewConfig(v1Config, v1FieldIds, v2FieldIdsByOld) {
  let cfg = {};
  try { cfg = JSON.parse(v1Config || "{}"); } catch {}

  const out = {};

  // fields: [{fieldId, visible}] → hiddenFieldIds
  if (Array.isArray(cfg.fields)) {
    const hidden = [];
    for (const f of cfg.fields) {
      if (!f.visible) {
        const newId = v2FieldIdsByOld.get(f.fieldId);
        if (newId) hidden.push(newId);
      }
    }
    out.hiddenFieldIds = hidden;
  }

  // groups: [fieldId,...] → groupByFieldId（仅取第一个）
  if (Array.isArray(cfg.groups) && cfg.groups.length > 0) {
    const newId = v2FieldIdsByOld.get(cfg.groups[0]);
    if (newId) out.groupByFieldId = newId;
  }

  // kanbanGroupFieldId → kanbanFieldId
  if (cfg.kanbanGroupFieldId) {
    const newId = v2FieldIdsByOld.get(cfg.kanbanGroupFieldId);
    if (newId) out.kanbanFieldId = newId;
  }

  // listTitleFieldId + listSubtitleFieldId → cardFieldIds
  const cardIds = [];
  if (cfg.listTitleFieldId) {
    const newId = v2FieldIdsByOld.get(cfg.listTitleFieldId);
    if (newId) cardIds.push(newId);
  }
  if (cfg.listSubtitleFieldId) {
    const newId = v2FieldIdsByOld.get(cfg.listSubtitleFieldId);
    if (newId) cardIds.push(newId);
  }
  if (Array.isArray(cfg.galleryFields)) {
    for (const fid of cfg.galleryFields) {
      const newId = v2FieldIdsByOld.get(fid);
      if (newId) cardIds.push(newId);
    }
  }
  if (cardIds.length > 0) out.cardFieldIds = cardIds;

  // rowHeight: v1 用 0/1/2 → v2 short/medium/tall
  if (typeof cfg.rowHeight === "number") {
    out.rowHeight = cfg.rowHeight === 0 ? "medium" : cfg.rowHeight === 1 ? "tall" : "short";
  }

  // sorts：v1 已经是 [{fieldId, dir}] 格式，但要 remap 字段 id
  if (Array.isArray(cfg.sorts)) {
    out.sorts = cfg.sorts
      .map((s) => {
        const newId = v2FieldIdsByOld.get(s.fieldId);
        return newId ? { fieldId: newId, dir: s.dir || "asc" } : null;
      })
      .filter(Boolean);
  }

  return out;
}

// ============ 主流程 ============

async function runMigration(opts) {
  const api = opts.api || process.env.V2_API || "http://127.0.0.1:3001";
  const dbPath = opts.db || `${process.env.HOME}/Library/Application Support/GouXiangDB/data.gxdb`;
  const baseName = opts.baseName || "v1 迁移数据";

  console.log(`📖 读取 v1 数据：${dbPath}`);
  const v1 = readV1(dbPath);
  console.log(`  base=${v1.bases.length} table=${v1.tables.length} field=${v1.fields.length} view=${v1.views.length} record=${Object.values(v1.records).reduce((s, r) => s + r.length, 0)} link_row=${v1.linkRows.length}`);

  if (opts.dryRun) {
    console.log(`\n🛑 干跑模式，不调用 v2 API\n`);
    console.log("计划创建 1 个 base：", baseName);
    console.log("=== 表 ===");
    for (const t of v1.tables) {
      const tFields = v1.fields.filter((f) => f.table_id === t.id);
      const skipped = tFields.filter((f) => !V1_TO_V2_TYPE[f.uidt]);
      console.log(`\n  table "${t.title}" (records=${v1.records[t.id]?.length ?? 0})`);
      for (const f of tFields) {
        const v2Type = V1_TO_V2_TYPE[f.uidt];
        if (v2Type) console.log(`    ✓ ${f.title} (${f.uidt} → ${v2Type})`);
        else console.log(`    ⏭ 跳过 ${f.title} (${f.uidt})`);
      }
    }
    console.log("\n=== 视图 ===");
    for (const v of v1.views) {
      const v2 = V1_TO_V2_VIEWTYPE[v.vtype];
      console.log(`  ${v.title} (${v.vtype} → ${v2 ?? "跳过"})`);
    }
    console.log(`\n=== 关联 ===`);
    console.log(`  ${v1.linkRows.length} 条 link_row`);
    console.log("\n✅ 干跑完成");
    return;
  }

  // Token：参数 --token > 环境变量 > 用 email/password 登录
  let token = opts.token || process.env.V2_TOKEN;
  if (!token && opts.email && opts.password) {
    const client0 = new V2Client(api);
    const r = await client0.login(opts.email, opts.password);
    token = r.token;
    console.log(`🔑 登录成功：${r.user.email}`);
  }
  if (!token) throw new Error("缺少 token：传 --token / --email+--password 或环境变量 V2_TOKEN / V2_EMAIL+V2_PASSWORD");
  const client = new V2Client(api, token);

  // 1) 建 base
  const v1Base = v1.bases[0];
  const baseResp = await client.createBase({
    name: baseName,
    iconColor: v1Base?.color || "#378ADD",
  });
  const newBaseId = baseResp.base.id;
  console.log(`✅ Base 已创建：${baseResp.base.name} (${newBaseId})`);

  // 1.5) 删除 v2 自动建的 starter table「数据表 1」（保留 base 内表结构干净）
  // 后续会按 v1 表名建同名表；starter 留在里面会重复
  try {
    const tables0 = (await client.req("GET", `/api/tables?baseId=${newBaseId}`)).tables;
    for (const t0 of tables0) {
      if (t0.name === "数据表 1" && v1.tables.some((t) => t.title === "数据表 1")) {
        await client.req("DELETE", `/api/tables/${t0.id}`);
        console.log(`🗑  已移除 starter table "${t0.name}" (${t0.id})`);
      }
    }
  } catch (e) {
    console.warn(`⚠ 清理 starter table 失败：${e.message}`);
  }

  // 2) 表 + 字段 + 视图 + 记录
  const tableIdMap = new Map();   // v1 tableId → v2 tableId
  const fieldIdMap = new Map();   // v1 fieldId → v2 fieldId
  const recordIdMap = new Map();  // v1 recordId → v2 recordId

  // 用于解析 v1 物理列名 → v2 字段 id
  const physicalToV2FieldId = new Map();

  for (const t of v1.tables) {
    console.log(`\n📋 创建数据表 "${t.title}"`);
    const tblResp = await client.createTable(newBaseId, { name: t.title, withDefaults: false });
    const newTableId = tblResp.table.id;
    tableIdMap.set(t.id, newTableId);

    // 把 v2 默认的"名称"字段也作为备选主显示字段
    const defaultNameField = (await client.req("GET", `/api/fields?tableId=${newTableId}`))
      .fields.find((f) => f.name === "名称" && f.type === "singleLineText");
    if (defaultNameField) {
      fieldIdMap.set(`__name__${t.id}`, defaultNameField.id);
    }
  }

  // 2.5) 字段：必须等所有表都建完才能解析 relatedTableId
  for (const t of v1.tables) {
    const newTableId = tableIdMap.get(t.id);
    const tFields = v1.fields
      .filter((f) => f.table_id === t.id)
      .sort((a, b) => {
        if (a.is_system !== b.is_system) return a.is_system - b.is_system;
        return (a.ord ?? 0) - (b.ord ?? 0);
      });

    console.log(`\n📐 创建字段（数据表 "${t.title}"）`);
    for (const f of tFields) {
      if (f.is_system) continue; // 系统字段 v2 自动建

      const mapped = mapFieldCreate(f, tableIdMap, fieldIdMap);
      if (mapped.skip) {
        console.log(`    ⏭ 跳过字段 "${f.title}"（uidt=${f.uidt}）`);
        continue;
      }
      try {
        const fieldResp = await client.createField(newTableId, mapped.body);
        const newFieldId = fieldResp.field.id;
        fieldIdMap.set(f.id, newFieldId);
        physicalToV2FieldId.set(f.physical, newFieldId);
        console.log(`    ✓ ${f.title} (${f.uidt} → ${mapped.v2Type})`);

        // links 字段：v2 自动建了反向字段，把 v1 的反向字段也映射进 fieldIdMap
        if (mapped.v2Type === "links" && fieldResp.reverseField) {
          let meta = {};
          try { meta = JSON.parse(f.meta_json || "{}"); } catch {}
          if (meta.reverseFieldId) {
            fieldIdMap.set(meta.reverseFieldId, fieldResp.reverseField.id);
          }
          // 也覆盖 v1 反向字段（isReverse=true）
          const reverseV1 = v1.fields.find(
            (rf) => rf.table_id === meta.relatedTableId && JSON.parse(rf.meta_json || "{}").reverseFieldId === f.id,
          );
          if (reverseV1) {
            fieldIdMap.set(reverseV1.id, fieldResp.reverseField.id);
          }
        }
      } catch (e) {
        console.error(`    ❌ 创建字段失败 "${f.title}"：${e.message}`);
      }
    }

    // 3) 视图
    const tViews = v1.views.filter((v) => v.table_id === t.id).sort((a, b) => a.ord - b.ord);
    for (const v of tViews) {
      const v2ViewType = V1_TO_V2_VIEWTYPE[v.vtype];
      if (!v2ViewType) continue;
      const v2Config = mapViewConfig(v.config_json, tFields.map((f) => f.id), fieldIdMap);
      try {
        await client.createView(newTableId, {
          name: v.title,
          type: v2ViewType,
          config: v2Config,
        });
        console.log(`    👁 视图 "${v.title}" (${v.vtype} → ${v2ViewType})`);
      } catch (e) {
        console.error(`    ❌ 创建视图失败 "${v.title}"：${e.message}`);
      }
    }

    // 4) 记录
    const tRecords = v1.records[t.id] ?? [];
    let successRec = 0;
    for (const r of tRecords) {
      const fieldsMap = {};
      for (const [key, val] of Object.entries(r)) {
        if (key === "id" || key === "created_at" || key === "updated_at" || key === "deleted") continue;
        if (val === null || val === undefined) continue;
        const newFieldId = physicalToV2FieldId.get(key);
        if (!newFieldId) continue;
        fieldsMap[newFieldId] = val;
      }
      try {
        const recResp = await client.createRecord(newTableId, { fields: fieldsMap });
        recordIdMap.set(r.id, recResp.record.id);
        successRec++;
      } catch (e) {
        console.error(`    ❌ 记录创建失败 id=${r.id}: ${e.message}`);
      }
    }
    console.log(`    📝 记录 ${successRec}/${tRecords.length} 条`);
  }

  // 5) 关联数据（link_row）：v1 link_field_id 是正向字段；v2 数据只挂在正向字段。
  // 按 v2 linkFieldId 分组，遍历每条 v1 link_row，对 v2 parent 行 PATCH [child recordId,...]
  const linkRowsByV2Field = new Map();
  let skippedLink = 0;
  for (const lr of v1.linkRows) {
    const v2LinkFieldId = fieldIdMap.get(lr.link_field_id);
    if (!v2LinkFieldId) { skippedLink++; continue; }
    const v2ParentId = recordIdMap.get(lr.parent_row_id);
    const v2ChildId = recordIdMap.get(lr.child_row_id);
    if (!v2ParentId || !v2ChildId) { skippedLink++; continue; }
    if (!linkRowsByV2Field.has(v2LinkFieldId)) {
      linkRowsByV2Field.set(v2LinkFieldId, new Map()); // v2ParentId → [v2ChildId,...]
    }
    const m = linkRowsByV2Field.get(v2LinkFieldId);
    if (!m.has(v2ParentId)) m.set(v2ParentId, []);
    m.get(v2ParentId).push(v2ChildId);
  }

  console.log(`\n🔗 写入关联数据（${v1.linkRows.length} 条 link_row，跳过 ${skippedLink} 条）`);
  for (const [v2LinkFieldId, parentMap] of linkRowsByV2Field) {
    for (const [parentId, childIds] of parentMap) {
      try {
        await client.patchRecord(parentId, {
          fields: { [v2LinkFieldId]: childIds.map((id) => ({ recordId: id })) },
        });
      } catch (e) {
        console.error(`    ⚠ 关联写入失败 parent=${parentId} field=${v2LinkFieldId}: ${e.message}`);
      }
    }
  }

  console.log(`\n🎉 迁移完成！新 base id：${newBaseId}`);
  console.log(`   登录 v2 后即可访问。`);
}

async function runSignup(opts) {
  const api = opts.api || process.env.V2_API || "http://127.0.0.1:3001";
  const client = new V2Client(api);
  if (!opts.email || !opts.password || !opts.displayName) {
    throw new Error("signup 需要 email password displayName");
  }
  const r = await client.signup(opts.email, opts.password, opts.displayName);
  console.log(`✅ 注册成功`);
  console.log(`   email: ${r.user.email}`);
  console.log(`   token: ${r.token}`);
  console.log(`   接下来：export V2_TOKEN='${r.token}'`);
  console.log(`          node scripts/migrate-from-v1.mjs run [--token 同上]`);
}

// ============ 入口 ============

const args = parseArgs(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }

try {
  if (args.subcommand === "signup") {
    await runSignup(args);
  } else {
    await runMigration(args);
  }
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
}
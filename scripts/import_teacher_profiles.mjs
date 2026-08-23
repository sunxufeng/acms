#!/usr/bin/env node
/**
 * 从飞书 wiki 表格（已 dump 为 source_table.json）导入教师档案（tblOhSv7Yr3WhJb0）。
 *
 * 用法（在服务器上，env 与 source json 都在本地）：
 *   node scripts/import_teacher_profiles.mjs [envPath] [sourceJsonPath] [--dry-run]
 *
 * 规则：
 *   - 跳过源表中「课酬标准（每小时）/每学期预计课酬总额/实际课酬总额」三列（用户要求）。
 *   - 仅写入目标表中真实存在的字段。
 *   - 多选字段（如 授课科目）：自动补齐源数据中缺失的选项，保证完整导入。
 *   - 单选字段：仅写入目标表已有选项；不在选项中的值安全跳过（避免污染字典/报错）。
 *   - 数值字段转为 Number；日期字段仅当值形如日期时写入。
 *   - 按「教师姓名」upsert：已存在则合并非空字段，不存在则新建。
 */
import fs from 'node:fs';

function loadEnv(path) {
  if (!path || !fs.existsSync(path)) return;
  const txt = fs.readFileSync(path, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const args = process.argv.slice(2);
const envPath = args.find((a) => a.endsWith('.env')) || '/opt/acms/.env';
const sourcePath = args.find((a) => a.endsWith('.json')) || './source_table.json';
const DRY = args.includes('--dry-run');

loadEnv(envPath);

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN;
const TABLE_ID = process.env.TEACHER_TABLE_ID || 'tblOhSv7Yr3WhJb0';

if (!APP_ID || !APP_SECRET || !BASE_TOKEN) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN');
  process.exit(1);
}

async function getToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    console.error('tenant_access_token failed:', JSON.stringify(data));
    process.exit(1);
  }
  return data.tenant_access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`https://open.feishu.cn${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`feishu ${method} ${path} -> ${data.code}: ${data.msg}`);
  return data.data;
}

// 源列（去掉换行）→ 目标字段名；null 表示跳过（含三个课酬字段）
const ALIAS = {
  '姓名': '教师姓名',
  '英语名': '英文名',
  '性别': '性别',
  '类别（全/兼）': '教师类别',
  '授课学段': '授课学段',
  '授课科目类型': '授课科目类型',
  '授课科目': '授课科目',
  '合作开始时间': '合作开始时间',
  '标准课时（每周）': '标准课时(每周)',
  '学期预计总课时': '学期预计总课时',
  '课酬标准（每小时）': null,
  '每学期预计课酬总额': null,
  '实际课酬总额': null,
  '内部对接人': '内部对接人',
  '学历/学位': '学历/学位',
  '毕业大学': '毕业大学',
  '手机号': '手机号',
  '微信号': '微信号',
  '邮箱': '邮箱',
  '合作状态': '在职合作状态',
  '常驻城市': '常驻城市',
  '开课人数说明': '开课人数说明',
  '个人描述': '个人描述',
  '附件': '附件',
  '教师合作等级': '教师合作等级',
  '教学评估': '教学评估',
  '收款主体（个人/公司）': '收款主体',
  'col28': null,
};

function norm(s) {
  return String(s ?? '').replace(/\n/g, '').replace(/\r/g, '').trim();
}

async function main() {
  const token = await getToken();

  // 1) 目标表字段（含 id / type / options）
  const fields = [];
  let pt;
  do {
    const d = await api(token, 'GET', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields?page_size=100${pt ? `&page_token=${pt}` : ''}`);
    for (const f of d.items ?? []) {
      fields.push({
        id: f.field_id,
        name: f.field_name,
        type: f.type,
        options: new Set((f.property?.options ?? []).map((o) => o.name)),
      });
    }
    pt = d.has_more ? d.page_token : undefined;
  } while (pt);
  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  console.log(`目标表字段数: ${fields.length}`);

  // 2) 源数据
  if (!fs.existsSync(sourcePath)) {
    console.error('source json not found:', sourcePath);
    process.exit(1);
  }
  const src = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const sheet = src.sheets?.[0];
  if (!sheet) {
    console.error('no sheet in source');
    process.exit(1);
  }
  const colNames = sheet.columns.map(norm);
  const rows = sheet.data || [];
  console.log(`源数据列数: ${colNames.length}, 数据行数: ${rows.length}`);

  const colToTarget = colNames.map((c) => {
    const t = ALIAS[c];
    if (t === null) return null;
    if (!t) return undefined;
    if (!fieldMap.has(t)) {
      console.log(`  [warn] 目标表无字段「${t}」（源列「${c}」），跳过`);
      return null;
    }
    return t;
  });

  // 3) 构建每行「原始映射」（用于收集待补齐的多选选项 + 实际写入）
  function buildRaw(row) {
    const raw = {};
    colNames.forEach((c, ci) => {
      const t = colToTarget[ci];
      if (!t) return;
      const v = row[ci];
      if (v === null || v === undefined || v === '') return;
      raw[t] = v;
    });
    const name = raw['教师姓名'];
    if (!name) return null;
    // 最佳实践：主要学科 ← 授课科目 第一个
    if (fieldMap.has('主要学科') && raw['授课科目'] && !raw['主要学科']) {
      const first = String(raw['授课科目']).split(/[,，、]/)[0].trim();
      if (first) raw['主要学科'] = first;
    }
    return raw;
  }

  // 4) 多选字段：补齐源数据中缺失的选项
  const distinctMulti = new Map(); // targetName -> Set
  for (const row of rows) {
    const raw = buildRaw(row);
    if (!raw) continue;
    for (const [t, v] of Object.entries(raw)) {
      const f = fieldMap.get(t);
      if (!f || f.type !== 4) continue;
      for (const part of String(v).split(/[,，、]/).map((s) => s.trim()).filter(Boolean)) {
        if (!distinctMulti.has(t)) distinctMulti.set(t, new Set());
        distinctMulti.get(t).add(part);
      }
    }
  }
  for (const [t, vals] of distinctMulti) {
    const f = fieldMap.get(t);
    const missing = [...vals].filter((v) => !f.options.has(v));
    if (!missing.length) continue;
    if (DRY) {
      console.log(`[dry] 将为多选字段「${t}」补选项: ${missing.join(', ')}`);
      missing.forEach((v) => f.options.add(v));
      continue;
    }
    await api(token, 'POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields/${f.id}/options`, {
      options: missing.map((name) => ({ name })),
    });
    missing.forEach((v) => f.options.add(v));
    console.log(`已为「${t}」补 ${missing.length} 个选项`);
  }

  // 5) 逐行写入
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const problems = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = buildRaw(rows[i]);
    if (!raw) {
      skipped++;
      continue;
    }
    const name = raw['教师姓名'];
    const fieldsToWrite = {};
    for (const [t, v] of Object.entries(raw)) {
      const f = fieldMap.get(t);
      if (!f) continue;
      if (f.type === 4) {
        const arr = String(v).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        const ok = arr.filter((x) => f.options.has(x));
        if (ok.length) fieldsToWrite[t] = ok;
      } else if (f.type === 3) {
        if (f.options.has(String(v))) fieldsToWrite[t] = String(v);
        else problems.push(`行${i + 1}「${name}」单选「${t}」值「${v}」不在选项，跳过`);
      } else if (f.type === 2) {
        const n = Number(v);
        if (!Number.isNaN(n)) fieldsToWrite[t] = n;
        else problems.push(`行${i + 1}「${name}」数值「${t}」值「${v}」非数字，跳过`);
      } else if (f.type === 5) {
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(v))) fieldsToWrite[t] = String(v);
        else problems.push(`行${i + 1}「${name}」日期「${t}」值「${v}」非日期，跳过`);
      } else {
        fieldsToWrite[t] = String(v);
      }
    }

    if (DRY) {
      console.log(`[dry] 行${i + 1} ${name}: 写入 ${Object.keys(fieldsToWrite).join(', ')}`);
      continue;
    }

    const existing = await api(token, 'POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/search?page_size=1`, {
      field_names: ['教师姓名'],
      filter: { conjunction: 'and', conditions: [{ field_name: '教师姓名', operator: 'is', value: [name] }] },
    });
    if (existing.items && existing.items.length) {
      const rid = existing.items[0].record_id;
      await api(token, 'PUT', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/${rid}`, { fields: fieldsToWrite });
      updated++;
    } else {
      await api(token, 'POST', `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`, { fields: fieldsToWrite });
      created++;
    }
  }

  console.log('── 结果 ──');
  console.log(`  新建: ${created}, 更新: ${updated}, 跳过(无姓名): ${skipped}`);
  if (problems.length) {
    console.log(`  提示(${problems.length}条，已安全跳过):`);
    [...new Set(problems)].slice(0, 25).forEach((p) => console.log('   - ' + p));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

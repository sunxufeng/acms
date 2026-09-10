#!/usr/bin/env node
/**
 * 扫描 PostgreSQL 中残留的「旧飞书素材 token」（非 loc_ 前缀）。
 *
 * 背景（2026-09-10）：存量附件迁移脚本只处理附件对象数组里的 file_token 键，
 * 邮件归档表「附件信息」字段（JSON 元信息，前端下载实际读它）与首页配置里的
 * logoUrl 这类「裸字符串 token」被整体漏掉，导致附件下载 404 才发现。
 *
 * 使用（在服务器 /opt/acms/repo 下，需 DATABASE_URL）：
 *   sudo DATABASE_URL="$(sudo grep -E '^DATABASE_URL=' /opt/acms/.env | cut -d= -f2-)" \
 *        node scripts/scan_legacy_tokens.cjs
 *
 * 只读，不修改任何数据。
 */
let Client;
try {
  ({ Client } = require('pg'));
} catch {
  console.error('需要 pg 模块：请在服务器 /opt/acms/repo 下运行（node_modules 已含 pg）');
  process.exit(1);
}

const KEY_RE = /token|logo|image|图片|背景|icon|url/i;

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows: tables } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 't_%' order by table_name`,
  );

  const stat = {};
  const all = [];
  for (const { table_name } of tables) {
    const { rows } = await client.query(`select id, data from public.${table_name}`);
    for (const r of rows) {
      const walk = (o, p) => {
        if (typeof o !== 'object' || o === null) return;
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string') {
            const s = v.trim();
            // 配置类字段常把整个 JSON 存成字符串，需下钻
            if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
              try {
                walk(JSON.parse(s), p + k + '.');
                continue;
              } catch {
                /* 不是 JSON，按普通字符串处理 */
              }
            }
            if (!KEY_RE.test(k)) continue;
            if (s.startsWith('loc_') || s.startsWith('http') || s.length < 20) continue;
            if (!/^[A-Za-z0-9_-]{20,}$/.test(s)) continue;
            const key = `${table_name} | ${p}${k}`;
            stat[key] = (stat[key] || 0) + 1;
            all.push({ table: table_name, id: r.id, field: p + k, value: s });
          } else if (typeof v === 'object') {
            walk(v, p + k + '.');
          }
        }
      };
      walk(r.data, '');
    }
  }
  await client.end();

  console.log('=== 残留旧 token（按 表|字段）===');
  Object.entries(stat)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(String(v).padStart(6) + '  ' + k));
  console.log('总计: ' + all.length);
  process.exit(all.length > 0 ? 0 : 0);
})();

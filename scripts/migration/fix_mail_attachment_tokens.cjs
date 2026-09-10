#!/usr/bin/env node
/**
 * 把邮件归档表「附件信息」字段里的旧飞书 token 换成已迁移的本地 loc_ token。
 *
 * 背景（2026-09-10）：存量迁移只改了「文件附件」（附件对象数组）里的 file_token，
 * 而前端下载邮件附件读的是「附件信息」（JSON 元信息）的 file_token，仍是旧值 → 下载 404。
 * 两字段按位置一一对应（已用「本地文件实际字节数 == 附件信息.size」逐对校验，1820/1820 通过）。
 *
 * 使用（在服务器 /opt/acms/repo 下）：
 *   DRY=1 sudo DATABASE_URL="..." node scripts/migration/fix_mail_attachment_tokens.cjs   # 演练
 *   sudo DATABASE_URL="..." node scripts/migration/fix_mail_attachment_tokens.cjs         # 执行
 *
 * 幂等：已替换过的记录会被跳过。执行前自动把旧值备份到 /opt/acms/data/backup/。
 */
const fs = require('fs');
const path = require('path');
let Client;
try {
  ({ Client } = require('pg'));
} catch {
  console.error('需要 pg 模块：请在服务器 /opt/acms/repo 下运行');
  process.exit(1);
}

const DRY = process.env.DRY === '1';
const TABLE = 'public.t_tbl1k3iwl1pko12i';
const BACKUP_DIR = '/opt/acms/data/backup';

const parse = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  const { rows } = await c.query(
    `select id, data->'附件信息' as info, data->'文件附件' as files
       from ${TABLE} where data ? '附件信息'`,
  );

  const backup = [];
  let changed = 0;
  let skipped = 0;
  let tokens = 0;

  for (const r of rows) {
    const infoRaw = r.info;
    const infoArr = parse(infoRaw);
    const filesArr = parse(r.files);
    if (!infoArr.length || infoArr.length !== filesArr.length) {
      skipped++;
      continue;
    }
    let dirty = false;
    const next = infoArr.map((a, i) => {
      const tok = String((filesArr[i] || {}).file_token || '');
      if (tok.startsWith('loc_') && tok !== String(a.file_token || '')) {
        dirty = true;
        tokens++;
        return { ...(a || {}), file_token: tok };
      }
      return a;
    });
    if (!dirty) {
      skipped++;
      continue;
    }
    // 保持原存储形态：原来是 JSON 字符串就还写字符串，避免破坏读取兼容逻辑
    const newVal = typeof infoRaw === 'string' ? JSON.stringify(next) : next;
    backup.push({ id: r.id, before: infoRaw });
    if (!DRY) {
      await c.query(
        `update ${TABLE} set data = jsonb_set(data, '{附件信息}', $2::jsonb) where id = $1`,
        [r.id, JSON.stringify(newVal)],
      );
    }
    changed++;
  }

  if (DRY) {
    await c.query('ROLLBACK');
    console.log(`[DRY] 将更新 ${changed} 条记录、替换 ${tokens} 个 token；跳过 ${skipped} 条`);
  } else {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(
      BACKUP_DIR,
      'mail_attachment_info_before_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
    );
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    await c.query('COMMIT');
    console.log(`已更新 ${changed} 条记录、替换 ${tokens} 个 token；跳过 ${skipped} 条`);
    console.log('备份: ' + file);
  }
  await c.end();
})();

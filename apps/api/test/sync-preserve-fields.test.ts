/**
 * 上游同步**不得清空本地字段**的守卫（2026-10-01 上线验证时揪出的真事故）。
 *
 * 事故经过：
 *   `syncAll()` 写联系人用的是「先 create，冲突了再 update」：
 *   ```ts
 *   try { await sql.createWithId(t, id, upstreamFields) } catch { await sql.update(t, id, upstreamFields) }
 *   ```
 *   但 `createWithId` 的 ON CONFLICT 分支是 `data = EXCLUDED.data`（**整体替换**），
 *   而且它是 upsert —— **冲突时不抛异常** ⇒ `catch` 永远不执行 ⇒
 *   整行 `data` 被上游字段覆盖，**所有本地字段被静默清空**
 *   （关联学生 / 关联学生ID / 匹配置信度 / 匹配依据 / 匹配时间 / 关联来源 / 跟进次数）。
 *
 *   实测：一次卫瓴同步抹掉 3 条已关联联系人的 5 个关联键 ——
 *   注意是键**消失**（不是变成空串），这正是"整行被替换"的指纹。
 *   以前看不出来，是因为紧随其后的 `matchStudents()` 会把命中的写回来；
 *   而 2026-10-01 把 55 分那档降级成"只提示不写库"之后，被抹掉的关联**再也回不来**。
 *
 * 🔴 本文件钉住三件事：
 *   ① `createWithId` 保持**整体替换**语义（配置行 upsert 依赖它，别被顺手改坏）
 *   ② `upsertMergeWithId` 用 `||` **合并**（保留未提及的键）
 *   ③ 联系人 / 跟进记录 / 字段描述的落库都走合并版
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..', '..');

const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');
/** 剥注释 —— 给 `not.toContain` 用（新代码的说明注释里就抄了旧写法） */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const STORE = read('apps', 'api', 'src', 'sql-store', 'sql-store.ts');
const SVC_CODE = stripComments(read('apps', 'api', 'src', 'weiling', 'weiling.service.ts'));

describe('① createWithId 保持「整体替换」语义（配置行 upsert 依赖它）', () => {
  it('ON CONFLICT 分支是 data = EXCLUDED.data', () => {
    const at = STORE.indexOf('async createWithId(');
    expect(at).toBeGreaterThan(-1);
    const block = STORE.slice(at, at + 700);
    expect(block).toContain('ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data');
  });
});

describe('② upsertMergeWithId 必须是「合并」', () => {
  it('方法存在', () => {
    expect(STORE).toContain('async upsertMergeWithId(');
  });

  it('🔴 ON CONFLICT 分支用 `||` 合并，而不是 `= EXCLUDED.data`', () => {
    const at = STORE.indexOf('async upsertMergeWithId(');
    const block = STORE.slice(at, at + 900);
    // 合并的关键就是这一句：旧 data 与新字段取并集（未提及的键保留）
    expect(block).toMatch(/ON CONFLICT \(id\) DO UPDATE SET data = \S+\.data \|\| EXCLUDED\.data/);
    expect(block).not.toContain('SET data = EXCLUDED.data');
  });

  it('列了「哪些字段会被顺带清掉」的说明（防以后有人又改成替换）', () => {
    const at = STORE.indexOf('async upsertMergeWithId(');
    const head = STORE.slice(Math.max(0, at - 2200), at);
    expect(head).toContain('关联来源');
    expect(head).toContain('EXCLUDED.data');
  });
});

describe('③ 上游同步的落库一律走合并版', () => {
  it('🔴 联系人落库不得再用 createWithId / try-catch-update', () => {
    expect(SVC_CODE).not.toContain('createWithId(TABLES.weilingContact.tableId');
    expect(SVC_CODE).toContain('upsertMergeWithId(TABLES.weilingContact.tableId');
  });

  it('跟进记录同样走合并版', () => {
    expect(SVC_CODE).toContain('upsertMergeWithId(TABLES.weilingProgress.tableId');
  });

  it('字段描述同样走合并版', () => {
    expect(SVC_CODE).toContain('upsertMergeWithId(TABLES.weilingField.tableId');
  });

  it('🔴 全文件不得再出现「先 create 再 update」的假兜底写法', () => {
    // 指纹：createWithId 紧邻一个 catch { … update( … ) }
    expect(SVC_CODE).not.toMatch(/createWithId\([\s\S]{0,120}?\}\s*catch\s*\{\s*await\s+sql\.update\(/);
  });
});

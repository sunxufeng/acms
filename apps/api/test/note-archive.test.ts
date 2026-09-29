import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NOTE_ARCHIVE_JOB_SEEDS,
  beijingClock,
  beijingDate,
  noteArchiveBody,
  noteArchiveFileName,
  noteArchiveRecordId,
  noteMatchesArchiveJob,
  normalizeOwnerFolderName,
  sanitizeFileNamePart,
  shouldRunArchiveJob,
  type NoteArchiveJobDef,
} from '@acms/contracts';

/**
 * 「笔记归档到飞书云盘」的判据测试（2026-09-22 峰哥：每天 01:00 IDP / 01:30 全量，
 * 按人分文件夹、每篇出明细与总结、文件名前缀日期、已复制过跳过）。
 *
 * 纯函数，不连数据库、不碰云盘。
 */

/** 种子任务按 key 取（2026-09-22 晚：任务改成数据行后，代码里的这份只是建表种子） */
const SEED: Record<string, NoteArchiveJobDef> = Object.fromEntries(
  NOTE_ARCHIVE_JOB_SEEDS.map((j) => [j.key, j]),
) as Record<string, NoteArchiveJobDef>;

describe('文件夹名归一（🔴 不归一就会给同一个人建两个文件夹）', () => {
  it('半角竖线 + 空格 → 全角｜（库里与云盘的真实差异）', () => {
    expect(normalizeOwnerFolderName('刘佳音 | Joy')).toBe('刘佳音｜Joy');
    expect(normalizeOwnerFolderName('蒋潘云 | Elsa')).toBe('蒋潘云｜Elsa');
  });

  it('本来就是全角的不动', () => {
    expect(normalizeOwnerFolderName('刘攀扬｜Amy')).toBe('刘攀扬｜Amy');
    expect(normalizeOwnerFolderName('孙旭峰｜Richard')).toBe('孙旭峰｜Richard');
  });

  it('空值给「未归属」——不让文件散落在根目录', () => {
    expect(normalizeOwnerFolderName('')).toBe('未归属');
    expect(normalizeOwnerFolderName(null)).toBe('未归属');
    expect(normalizeOwnerFolderName('   ')).toBe('未归属');
  });

  it('幂等：归一两次结果相同（跑两遍不会又变一个名字）', () => {
    const once = normalizeOwnerFolderName('刘佳音 | Joy');
    expect(normalizeOwnerFolderName(once)).toBe(once);
  });
});

describe('文件名：`YYYY-MM-DD 标题-明细__<笔记ID>.md`', () => {
  it('范例形态', () => {
    expect(
      noteArchiveFileName({
        date: '2026-09-14',
        title: '阿卡迪亚学院与BIA_VIA的Cognia认证评审会议记录',
        kind: '明细',
        noteId: '1921389369026187104',
      }),
    ).toBe('2026-09-14 阿卡迪亚学院与BIA_VIA的Cognia认证评审会议记录-明细__1921389369026187104.md');
  });

  it('🔴 带笔记 ID 是为了「同人同日同标题」不撞名（库里真实存在）', () => {
    // 实测：刘佳音 | Joy 在 2026-09-12 有两条标题都叫「无内容」
    const a = noteArchiveFileName({ date: '2026-09-12', title: '无内容', kind: '总结', noteId: '1921aaaa' });
    const b = noteArchiveFileName({ date: '2026-09-12', title: '无内容', kind: '总结', noteId: '1921bbbb' });
    expect(a).not.toBe(b);
    expect(a).toContain('__1921aaaa.md');
  });

  it('文件名里的非法字符被清掉（斜杠会把名字截成两级路径）', () => {
    const n = noteArchiveFileName({
      date: '2026-09-01',
      title: 'A/B:C*D?E"F<G>H|I 测试',
      kind: '总结',
      noteId: 'x',
    });
    expect(n).toBe('2026-09-01 ABCDEFGHI 测试-总结__x.md');
  });

  it('空标题给「无标题」；超长标题截断（避免超出云盘文件名上限）', () => {
    expect(noteArchiveFileName({ date: '2026-09-01', title: '   ', kind: '明细', noteId: 'x' })).toContain('无标题-明细');
    const long = '啊'.repeat(200);
    const n = noteArchiveFileName({ date: '2026-09-01', title: long, kind: '明细', noteId: 'x' });
    expect(n.length).toBeLessThan(140);
    expect(n.endsWith('-明细__x.md')).toBe(true);
  });

  it('日期为空时仍可用（不生成前导空格的文件名）', () => {
    const n = noteArchiveFileName({ date: '', title: '标题', kind: '总结', noteId: 'x' });
    expect(n.startsWith(' 标题')).toBe(false);
  });

  it('sanitizeFileNamePart 保留中文与字母数字、压掉多余空白', () => {
    expect(sanitizeFileNamePart('  a   b  ')).toBe('a b');
    expect(sanitizeFileNamePart('刘洋洋与博远一对一升学面谈记录')).toBe('刘洋洋与博远一对一升学面谈记录');
    expect(sanitizeFileNamePart('..隐藏..')).toBe('隐藏');
  });
});

describe('任务筛选与到点判据', () => {
  it('IDP 任务只收标题含 IDP 的（大小写不敏感）', () => {
    const idp = SEED.idp!;
    expect(noteMatchesArchiveJob('张宇翔第一次IDP面谈记录', idp)).toBe(true);
    expect(noteMatchesArchiveJob('idp 小写也要收', idp)).toBe(true);
    expect(noteMatchesArchiveJob('普通会议记录', idp)).toBe(false);
    expect(noteMatchesArchiveJob('', idp)).toBe(false);
  });

  it('全量任务不过滤标题', () => {
    const all = SEED.all!;
    expect(noteMatchesArchiveJob('普通会议记录', all)).toBe(true);
    expect(noteMatchesArchiveJob('', all)).toBe(true);
  });

  it('两个任务的时间与目标文件夹（峰哥指定：1:00 / 1:30，两个不同文件夹）', () => {
    expect([SEED.idp!.hour, SEED.idp!.minute]).toEqual([1, 0]);
    expect([SEED.all!.hour, SEED.all!.minute]).toEqual([1, 30]);
    expect(SEED.idp!.rootFolderToken).toBe('VULJfnQXjlbHvEdP4clcqQbBnOc');
    expect(SEED.all!.rootFolderToken).toBe('K6IjfMZuOlq8D3dwytfcnGjYnSh');
  });

  it('🔴 到点判据走北京时间，不受服务器时区影响', () => {
    // 2026-09-22 17:00 UTC = 北京时间 2026-09-23 01:00
    const utc17 = new Date('2026-09-22T17:00:00Z');
    const c = beijingClock(utc17);
    expect(c.day).toBe('2026-09-23');
    expect(c.minutes).toBe(60); // 01:00 → 恰好命中 IDP 任务
    // UTC 当天 01:00 ≠ 北京 01:00（差 8 小时）—— 这是最容易写错的一处
    expect(beijingClock(new Date('2026-09-22T01:00:00Z')).minutes).toBe(9 * 60);
  });

  it('日期用毫秒时间戳算北京时间', () => {
    expect(beijingDate(Date.parse('2026-09-14T02:00:00Z'))).toBe('2026-09-14');
    expect(beijingDate(Date.parse('2026-09-13T17:00:00Z'))).toBe('2026-09-14'); // +8 后跨日
    expect(beijingDate(0)).toBe('');
    expect(beijingDate(Number.NaN)).toBe('');
  });
});

describe('🔴 到点判据 shouldRunArchiveJob（补跑窗口）', () => {
  const idp = SEED.idp!; // 01:00，窗口 6h
  const all = SEED.all!; // 01:30，窗口 6h

  it('没到点不跑', () => {
    expect(shouldRunArchiveJob(idp, 0, false)).toBe(false); // 00:00
    expect(shouldRunArchiveJob(idp, 59, false)).toBe(false); // 00:59
    expect(shouldRunArchiveJob(all, 60, false)).toBe(false); // 01:00（all 是 01:30）
  });

  it('到点就跑（含窗口内的补跑）', () => {
    expect(shouldRunArchiveJob(idp, 60, false)).toBe(true); // 01:00 整
    expect(shouldRunArchiveJob(idp, 61, false)).toBe(true); // 01:01（刚重启）
    expect(shouldRunArchiveJob(idp, 6 * 60, false)).toBe(true); // 06:00，窗口边缘
    expect(shouldRunArchiveJob(all, 90, false)).toBe(true); // 01:30 整
  });

  it('🔴 出了窗口就不跑 —— 这条就是今天踩的那个 bug', () => {
    // 21:13 部署重启：只看「已过 01:00」的话会被判成「今天该跑却没跑」⇒ 当场跑全量
    expect(shouldRunArchiveJob(idp, 21 * 60 + 13, false)).toBe(false);
    expect(shouldRunArchiveJob(idp, 7 * 60 + 1, false)).toBe(false); // 07:01，刚出窗口
    expect(shouldRunArchiveJob(all, 21 * 60 + 13, false)).toBe(false);
  });

  it('今天已经跑过就不再跑（同一天多次 tick 只跑一次）', () => {
    expect(shouldRunArchiveJob(idp, 60, true)).toBe(false);
    expect(shouldRunArchiveJob(idp, 6 * 60, true)).toBe(false);
  });

  it('两个任务的窗口不重叠（IDP 先跑、全量后跑，各自独立判定）', () => {
    expect(shouldRunArchiveJob(idp, 60, false)).toBe(true);
    expect(shouldRunArchiveJob(all, 60, false)).toBe(false);
    expect(shouldRunArchiveJob(all, 90, false)).toBe(true); // 此时 idp 已跑过（ranToday=true）
    expect(shouldRunArchiveJob(idp, 90, true)).toBe(false);
  });
});

describe('归档记录与正文', () => {
  it('记录行 id = `<笔记ID>__<任务>`（幂等 upsert 的钥匙，两个任务互不覆盖）', () => {
    expect(noteArchiveRecordId('1921389369026187104', 'idp')).toBe('1921389369026187104__idp');
    expect(noteArchiveRecordId('1921389369026187104', 'all')).toBe('1921389369026187104__all');
  });

  it('正文头部含类型/归属人/时间/ID，且**原文一行不改**地接在后面', () => {
    const body = noteArchiveBody({
      title: '示例标题',
      kind: '总结',
      noteId: 'abc123',
      owner: '刘佳音 | Joy',
      createdAtMs: Date.parse('2026-09-14T02:00:00Z'),
      content: '### 📑 智能总结\n\n正文内容',
    });
    expect(body).toContain('# 示例标题');
    expect(body).toContain('- 类型：总结');
    expect(body).toContain('- 归属人：刘佳音 | Joy');
    expect(body).toContain('- 笔记时间：2026-09-14');
    expect(body).toContain('- 笔记 ID：abc123');
    expect(body.trim().endsWith('正文内容')).toBe(true);
  });

  it('空标题正文头部不出现 "undefined"', () => {
    const body = noteArchiveBody({ title: '', kind: '明细', noteId: 'x', owner: '', createdAtMs: 0, content: 'c' });
    expect(body).toContain('# 无标题');
    expect(body).not.toContain('undefined');
  });
});

/**
 * 内容去重（2026-09-30 峰哥：「全部有效笔记和 IDP 笔记，复制到飞书文档时，
 * 目前是文件名如果一致即不复制，**增加一个条件：虽然文件名不一致，但是文件内容是一致的，也不需要复制了**」）。
 *
 * 为什么原有两道防线都拦不住：
 *  ① 主判据按**笔记 ID**（`<笔记ID>__<任务标识>`）—— 两个任务的任务标识不同 ⇒ 记录不同 ⇒ 各传一份；
 *  ② 同名文件判据按**文件名**（含笔记 ID / 日期）—— 不同笔记天然不同名。
 * 判据 = `文件夹Token + kind + 内容哈希`，**跨任务**查。
 */
describe('笔记归档 · 内容去重（v 2026-09-30）', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const SVC = readFileSync(`${root}apps/api/src/note-archive/note-archive.service.ts`, 'utf8');

  it('🔴 归档记录表新增两个哈希字段（漏了就是永远判不出重复）', () => {
    expect(SVC).toContain("明细哈希: '明细哈希'");
    expect(SVC).toContain("总结哈希: '总结哈希'");
    // 建表数组里也要有（ensureTable 是 upsert ⇒ 加进去部署即生效）
    expect(SVC).toContain('{ name: ARCHIVE_FIELDS.明细哈希');
    expect(SVC).toContain('{ name: ARCHIVE_FIELDS.总结哈希');
  });

  it('🔴 判据 = 文件夹Token + kind + 内容哈希，且**跨任务**（加载时不得按 jobKey 过滤）', () => {
    const i = SVC.indexOf('private async loadContentIndex(');
    expect(i).toBeGreaterThan(0);
    const j = SVC.indexOf('private async loadStatusMap(', i);
    // ⚠️ 窗口贴紧到下一个方法（别用固定长度：会框进别的方法体，断言就测错对象了）
    const body = SVC.slice(i, j > i ? j : i + 2200);
    expect(body).toContain('${ft}:明细:${dh}');
    expect(body).toContain('${ft}:总结:${sh}');
    // 只认成功记录（失败记录里的哈希不可信 —— 文件可能根本没传上去）
    expect(body).toContain('NOTE_ARCHIVE_OK');
    // 反向：不许按 jobKey 过滤，否则"两个任务之间去重"这件事直接做不到
    expect(body).not.toContain('jobKey');
  });

  it('上传前先查内容索引，命中即跳过并**单独计数**（否则"上传变少了"没法解释）', () => {
    expect(SVC).toContain('if (this.contentIndex.has(ckey))');
    expect(SVC).toContain('p.skippedByContent += 1');
    expect(SVC).toContain('内容重复 ${p.skippedByContent}');
  });

  it('索引每次运行重建 + 上传成功后写入（同一次运行内也不重复传）', () => {
    expect(SVC).toContain('this.contentIndex.clear()');
    expect(SVC).toContain('this.contentIndex.set(ckey, true)');
  });

  it('哈希用 sha256 截断 32 位（够用且便于人工比对）', () => {
    expect(SVC).toContain("createHash('sha256')");
    expect(SVC).toContain("digest('hex').slice(0, 32)");
  });
});

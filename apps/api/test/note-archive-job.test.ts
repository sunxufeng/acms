/**
 * 「定时任务」页面的任务口径单测（2026-09-22 晚：任务从代码常量搬成数据行）。
 *
 * 这一层挡的是**人手填错**：时间写成 `25:00`、文件夹粘错、执行日选了不存在的值……
 * 配错的后果不是报错，而是**凌晨静默失败**（或更糟：写进别人的文件夹）——
 * 所以解析必须容错、问题必须显式列出来（`validateArchiveJob`）。
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_JOB_FIELDS,
  ARCHIVE_JOB_WEEKDAY_ANY,
  NOTE_ARCHIVE_JOB_DEFAULTS,
  NOTE_ARCHIVE_JOB_SEEDS,
  archiveJobScheduleText,
  jobRunsOnWeekday,
  normalizeKinds,
  normalizeWeekdays,
  parseArchiveJobRow,
  parseFolderToken,
  parseTimeOfDay,
  parseYesNo,
  shouldRunArchiveJob,
  validateArchiveJob,
  weekdaySummary,
  type NoteArchiveJobDef,
} from '@acms/contracts';

const seed = (key: string): NoteArchiveJobDef => {
  const hit = NOTE_ARCHIVE_JOB_SEEDS.find((s) => s.key === key);
  if (!hit) throw new Error(`种子任务缺失：${key}`);
  return hit;
};

describe('目标文件夹：粘链接也要能用（🔴 填错的后果是写进别人的文件夹）', () => {
  it('浏览器地址里抠出 token', () => {
    expect(parseFolderToken('https://ccnyntd8vksu.feishu.cn/drive/folder/VULJfnQXjlbHvEdP4clcqQbBnOc')).toBe(
      'VULJfnQXjlbHvEdP4clcqQbBnOc',
    );
  });

  it('带查询串、带尾部斜杠、前后有空格都能认', () => {
    expect(
      parseFolderToken('  https://x.feishu.cn/drive/folder/K6IjfMZuOlq8D3dwytfcnGjYnSh?from=space&a=1  '),
    ).toBe('K6IjfMZuOlq8D3dwytfcnGjYnSh');
    expect(parseFolderToken('https://x.feishu.cn/drive/folder/K6IjfMZuOlq8D3dwytfcnGjYnSh/')).toBe(
      'K6IjfMZuOlq8D3dwytfcnGjYnSh',
    );
  });

  it('直接填 token 也认', () => {
    expect(parseFolderToken('VULJfnQXjlbHvEdP4clcqQbBnOc')).toBe('VULJfnQXjlbHvEdP4clcqQbBnOc');
  });

  it('🔴 认不出的**返空**而不是原样返回 —— 宁可不跑，也不要把文件写错地方', () => {
    expect(parseFolderToken('')).toBe('');
    expect(parseFolderToken('   ')).toBe('');
    expect(parseFolderToken('我的文件夹')).toBe('');
    expect(parseFolderToken('https://x.feishu.cn/drive/home/')).toBe('');
    expect(parseFolderToken(undefined)).toBe('');
  });
});

describe('执行时间解析（容错，但绝不猜）', () => {
  it('标准写法与几种手写变体', () => {
    expect(parseTimeOfDay('01:00')).toEqual({ hour: 1, minute: 0 });
    expect(parseTimeOfDay('1:00')).toEqual({ hour: 1, minute: 0 });
    expect(parseTimeOfDay('0130')).toEqual({ hour: 1, minute: 30 });
    expect(parseTimeOfDay('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay('01：30')).toEqual({ hour: 1, minute: 30 }); // 全角冒号
  });

  it('🔴 越界/乱填返 null（不能猜成 00:00 —— 那会让任务在半夜偷偷跑）', () => {
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('01:60')).toBeNull();
    expect(parseTimeOfDay('abc')).toBeNull();
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('-1:00')).toBeNull();
  });
});

describe('执行日（多选）', () => {
  it('勾「每天」或空 ⇒ 空数组 = 每天', () => {
    expect(normalizeWeekdays([ARCHIVE_JOB_WEEKDAY_ANY])).toEqual([]);
    expect(normalizeWeekdays([])).toEqual([]);
    expect(normalizeWeekdays('')).toEqual([]);
    expect(normalizeWeekdays(undefined)).toEqual([]);
  });

  it('勾具体周几 ⇒ 升序去重', () => {
    expect(normalizeWeekdays(['周三', '周一'])).toEqual([1, 3]);
    expect(normalizeWeekdays(['周一', '周一', '周日'])).toEqual([0, 1]);
    expect(normalizeWeekdays('周五')).toEqual([5]);
  });

  it('认不出的值被丢掉（不让一个错字把任务变成"从不跑"）', () => {
    expect(normalizeWeekdays(['周一', '星期八'])).toEqual([1]);
    expect(normalizeWeekdays(['礼拜一'])).toEqual([]);
  });

  it('展示文案：空 = 每天', () => {
    expect(weekdaySummary([])).toBe(ARCHIVE_JOB_WEEKDAY_ANY);
    expect(weekdaySummary([1, 3])).toBe('周一、周三');
  });

  it('jobRunsOnWeekday：空数组谁都算命中', () => {
    const job = { ...seed('all'), weekdays: [] };
    for (let d = 0; d <= 6; d += 1) expect(jobRunsOnWeekday(job, d)).toBe(true);
    const mon = { ...seed('all'), weekdays: [1] };
    expect(jobRunsOnWeekday(mon, 1)).toBe(true);
    expect(jobRunsOnWeekday(mon, 2)).toBe(false);
  });
});

describe('输出内容与是/否', () => {
  it('至少留一个内容类型（都不选 = 任务什么都不干）', () => {
    expect(normalizeKinds(['明细', '总结'])).toEqual(['明细', '总结']);
    expect(normalizeKinds(['总结'])).toEqual(['总结']);
    expect(normalizeKinds([])).toEqual(['总结']);
    expect(normalizeKinds(['x'])).toEqual(['总结']);
  });

  it('是/否：空走默认值，别把没填当成否', () => {
    expect(parseYesNo('是', false)).toBe(true);
    expect(parseYesNo('否', true)).toBe(false);
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo(undefined, true)).toBe(true);
    expect(parseYesNo('随便', true)).toBe(true);
  });
});

describe('任务行 → 运行口径 parseArchiveJobRow', () => {
  it('正常一行全部解析出来', () => {
    const job = parseArchiveJobRow('rec_abc', {
      [ARCHIVE_JOB_FIELDS.任务名称]: '周报归档',
      [ARCHIVE_JOB_FIELDS.启用]: '是',
      [ARCHIVE_JOB_FIELDS.执行时间]: '09:30',
      [ARCHIVE_JOB_FIELDS.执行日]: ['周一', '周五'],
      [ARCHIVE_JOB_FIELDS.目标文件夹]: 'https://x.feishu.cn/drive/folder/AbCdEf123456',
      [ARCHIVE_JOB_FIELDS.标题关键词]: 'idp',
      [ARCHIVE_JOB_FIELDS.输出内容]: ['总结'],
      [ARCHIVE_JOB_FIELDS.按人分文件夹]: '否',
      [ARCHIVE_JOB_FIELDS.补跑窗口]: 3,
    });
    expect(job).toEqual({
      key: 'rec_abc',
      label: '周报归档',
      enabled: true,
      hour: 9,
      minute: 30,
      weekdays: [1, 5],
      rootFolderToken: 'AbCdEf123456',
      titleMustInclude: 'idp',
      kinds: ['总结'],
      groupByOwner: false,
      catchUpHours: 3,
    });
  });

  it('🔴 空行不崩：回落到安全默认值（定时器崩掉 = 当天不归档，且没人知道）', () => {
    const job = parseArchiveJobRow('rec_empty', {});
    expect(job.key).toBe('rec_empty');
    expect(job.enabled).toBe(true);
    expect(job.weekdays).toEqual([]);
    expect(job.kinds).toEqual(['总结']);
    expect(job.groupByOwner).toBe(true);
    expect(job.titleMustInclude).toBe('');
    expect(job.label).toBe('任务 rec_empty');
  });

  it('种子任务 id 的行沿用种子里的时间与文件夹（升级容错：读不到字段也不跑错地方）', () => {
    const idp = parseArchiveJobRow('idp', {});
    expect([idp.hour, idp.minute]).toEqual([1, 0]);
    expect(idp.rootFolderToken).toBe('VULJfnQXjlbHvEdP4clcqQbBnOc');
    expect(idp.label).toBe('IDP 笔记');
  });

  it('时间乱填 ⇒ 回落默认时刻而不是 00:00', () => {
    const job = parseArchiveJobRow('idp', { [ARCHIVE_JOB_FIELDS.执行时间]: '25:99' });
    expect([job.hour, job.minute]).toEqual([1, 0]);
  });
});

describe('配置体检 validateArchiveJob（配错要看得见，而不是等凌晨静默失败）', () => {
  it('种子任务是干净的', () => {
    for (const s of NOTE_ARCHIVE_JOB_SEEDS) expect(validateArchiveJob(s)).toEqual([]);
  });

  it('文件夹解析不出 ⇒ 报出来', () => {
    expect(validateArchiveJob({ ...seed('all'), rootFolderToken: '' })).toContain(
      '目标文件夹解析不出 token（请粘文件夹链接或 26 位 token）',
    );
  });

  it('新建表单的默认值本身是合法的（否则"新建即报错"）', () => {
    const job = parseArchiveJobRow('rec_new', NOTE_ARCHIVE_JOB_DEFAULTS);
    // 默认值里没有目标文件夹（用户必须自己填），所以只有这一条问题
    expect(validateArchiveJob(job)).toEqual(['目标文件夹解析不出 token（请粘文件夹链接或 26 位 token）']);
  });
});

describe('🔴 到点判据补上"周几"与"停用"两个维度', () => {
  const monday = 1;
  const tuesday = 2;

  it('停用的任务怎么都不跑（但手动仍可运行 —— 那条路径不经过本判据）', () => {
    const off = { ...seed('all'), enabled: false };
    expect(shouldRunArchiveJob(off, 90, false, monday)).toBe(false);
  });

  it('不在执行日就不跑（补跑窗口也不越界到别的日子）', () => {
    const monOnly = { ...seed('all'), weekdays: [monday] };
    expect(shouldRunArchiveJob(monOnly, 90, false, monday)).toBe(true);
    expect(shouldRunArchiveJob(monOnly, 90, false, tuesday)).toBe(false);
  });

  it('「每天」的任务任何一天都跑', () => {
    const everyday = { ...seed('all'), weekdays: [] };
    for (let d = 0; d <= 6; d += 1) expect(shouldRunArchiveJob(everyday, 90, false, d)).toBe(true);
  });

  it('补跑窗口仍生效（重启不要触发全量）', () => {
    const everyday = { ...seed('all'), weekdays: [] }; // 01:30 + 6h ⇒ 07:30 前
    expect(shouldRunArchiveJob(everyday, 90, false, monday)).toBe(true);
    expect(shouldRunArchiveJob(everyday, 7 * 60 + 30, false, monday)).toBe(true);
    expect(shouldRunArchiveJob(everyday, 7 * 60 + 31, false, monday)).toBe(false); // 出窗口
    expect(shouldRunArchiveJob(everyday, 22 * 60, false, monday)).toBe(false); // 晚上重启不再触发
  });

  it('执行安排文案', () => {
    expect(archiveJobScheduleText(seed('idp'))).toBe('每天 01:00');
    expect(archiveJobScheduleText({ ...seed('all'), weekdays: [1, 3], hour: 9, minute: 5 })).toBe('周一、周三 09:05');
  });
});

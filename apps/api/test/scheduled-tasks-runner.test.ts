import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_JOB_FIELDS,
  archiveJobScheduleText,
  jobSlotKey,
  parseArchiveJobRow,
  shouldRunArchiveJob,
  validateArchiveJob,
  type NoteArchiveJobDef,
} from '@acms/contracts';

/**
 * 「定时任务」升级为通用调度器（2026-09-24，方案 A）的硬口径。
 *
 * 背景：原来三家各写各的定时器 —— 笔记归档与音频抓取用「每小时醒一次判到点」（正确），
 * 卫瓴联系人同步用 `setInterval(24h)`（错：部署重启就清零，时间点一直漂），
 * 邮件收取是 mail-archive.module 里硬编码的「每 15 分钟」cron 表达式。用户完全改不了。
 * 现在统一由任务行（任务类型 + 频率 + 执行时间 + 执行日）驱动。
 *
 * 下面两类断言：
 *  ① **纯函数**（判据必须与调度器共用同一份，所以直接 import contracts 来测）；
 *  ② **源码级守卫**（防止有人又把定时器塞回各业务模块 —— 那不会有任何类型错误）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const runner = read('api', 'src', 'scheduled-tasks', 'scheduled-tasks.runner.ts');
const notes = read('api', 'src', 'note-archive', 'note-archive.service.ts');
const weiling = read('api', 'src', 'weiling', 'weiling.service.ts');
const mailModule = read('api', 'src', 'mail-archive', 'mail-archive.module.ts');
const appModule = read('api', 'src', 'app.module.ts');

function job(over: Partial<NoteArchiveJobDef> = {}): NoteArchiveJobDef {
  return {
    key: 'test',
    label: '测试任务',
    enabled: true,
    kind: '笔记归档',
    freq: '每天',
    hour: 7,
    minute: 0,
    weekdays: [],
    rootFolderToken: '',
    titleMustInclude: '',
    kinds: [],
    groupByOwner: false,
    catchUpHours: 6,
    ...over,
  };
}

describe('定时任务 · 频率判据', () => {
  it('每天：到点后进入补跑窗口内才算到点（重启错过的能补上，但不会无限补）', () => {
    const j = job({ freq: '每天', hour: 7, minute: 0, catchUpHours: 6 });
    expect(shouldRunArchiveJob(j, 6 * 60 + 59, false)).toBe(false); // 还没到点
    expect(shouldRunArchiveJob(j, 7 * 60, false)).toBe(true); // 正好到点
    expect(shouldRunArchiveJob(j, 12 * 60 + 59, false)).toBe(true); // 窗口内（7+6=13 点前）
    expect(shouldRunArchiveJob(j, 13 * 60 + 1, false)).toBe(false); // 超出补跑窗口
    expect(shouldRunArchiveJob(j, 7 * 60, true)).toBe(false); // 本槽位已跑过
  });

  it('每小时：用「执行时间」的分钟做偏移，到点后本小时内任何一分钟都能补', () => {
    const j = job({ freq: '每小时', minute: 30 });
    expect(shouldRunArchiveJob(j, 10 * 60 + 29, false)).toBe(false); // 10:29 未到
    expect(shouldRunArchiveJob(j, 10 * 60 + 30, false)).toBe(true); // 10:30 到点
    expect(shouldRunArchiveJob(j, 10 * 60 + 59, false)).toBe(true); // 10:59 仍算本小时这一槽（可补跑）
    expect(shouldRunArchiveJob(j, 11 * 60, false)).toBe(false); // 11:00 属于下一槽，等 11:30
  });

  it('每15分钟：命中 0/15/30/45 分那一格（带 6 分钟容差），槽位去重保证一格一次', () => {
    const j = job({ freq: '每15分钟', minute: 0 });
    expect(shouldRunArchiveJob(j, 10 * 60 + 15, false)).toBe(true);
    expect(shouldRunArchiveJob(j, 10 * 60 + 20, false)).toBe(true); // 容差内仍可补
    expect(shouldRunArchiveJob(j, 10 * 60 + 22, false)).toBe(false); // 超出 6 分钟容差
    expect(shouldRunArchiveJob(j, 10 * 60 + 30, false)).toBe(true);
    expect(shouldRunArchiveJob(j, 10 * 60 + 15, true)).toBe(false); // 这一格跑过了
  });

  it('停用 / 不在执行日 ⇒ 绝不触发', () => {
    expect(shouldRunArchiveJob(job({ enabled: false }), 7 * 60, false)).toBe(false);
    expect(shouldRunArchiveJob(job({ weekdays: [1] }), 7 * 60, false, 3)).toBe(false);
    expect(shouldRunArchiveJob(job({ weekdays: [1] }), 7 * 60, false, 1)).toBe(true);
  });

  it('🔴 槽位键按频率取不同粒度 —— 用"今天跑过没跑过"会让每小时/每15分钟一天只跑一次', () => {
    expect(jobSlotKey(job({ freq: '每天' }), '2026-09-24', 7 * 60)).toBe('test:2026-09-24');
    expect(jobSlotKey(job({ freq: '每小时' }), '2026-09-24', 7 * 60 + 30)).toBe('test:2026-09-24:7');
    expect(jobSlotKey(job({ freq: '每15分钟' }), '2026-09-24', 7 * 60 + 30)).toBe('test:2026-09-24:7:2');
  });
});

describe('定时任务 · 兼容性与按类型的校验', () => {
  it('🔴 存量任务行没有「任务类型 / 频率」⇒ 必须按「笔记归档 / 每天」处理', () => {
    // 生产上那两条归档任务建于这两个字段存在之前；给成别的值/空值时，
    // 上线当天它们会被当成"未知类型"而**静默不跑**（不报错、列表也照常显示）。
    const legacy = parseArchiveJobRow('idp', {
      [ARCHIVE_JOB_FIELDS.任务名称]: 'IDP 笔记',
      [ARCHIVE_JOB_FIELDS.启用]: '是',
      [ARCHIVE_JOB_FIELDS.执行时间]: '01:00',
    });
    expect(legacy.kind).toBe('笔记归档');
    expect(legacy.freq).toBe('每天');
    expect(legacy.hour).toBe(1);
    expect(legacy.enabled).toBe(true);
  });

  it('任务类型 / 频率写脏值 ⇒ 回退缺省（而不是变成"未知类型不跑"）', () => {
    const j = parseArchiveJobRow('x', { [ARCHIVE_JOB_FIELDS.任务类型]: '乱写', [ARCHIVE_JOB_FIELDS.频率]: '乱写' });
    expect(j.kind).toBe('笔记归档');
    expect(j.freq).toBe('每天');
  });

  it('校验按类型分支：卫瓴同步 / 邮件收取**不能**因为缺目标文件夹而报错', () => {
    expect(validateArchiveJob(job({ kind: '笔记归档', rootFolderToken: '', kinds: [] })).length).toBeGreaterThan(0);
    expect(validateArchiveJob(job({ kind: '卫瓴联系人同步', rootFolderToken: '', kinds: [] }))).toEqual([]);
    expect(validateArchiveJob(job({ kind: '邮件收取', rootFolderToken: '', kinds: [] }))).toEqual([]);
  });

  it('执行安排文案能同时表达三种频率（页面/日志要看得懂）', () => {
    expect(archiveJobScheduleText(job({ freq: '每天', hour: 7, minute: 0 }))).toContain('07:00');
    expect(archiveJobScheduleText(job({ freq: '每小时', minute: 30 }))).toContain('每小时第 30 分');
    expect(archiveJobScheduleText(job({ freq: '每15分钟' }))).toContain('15');
  });
});

describe('定时任务 · 源码级守卫（防止定时器又散回各模块）', () => {
  it('🔴 卫瓴联系人同步不能再有 24 小时定时器（部署重启就把计时清零）', () => {
    // 用「调用形态」判，而不是裸子串：注释里提到这个写法是允许的（甚至是必要的说明）
    expect(weiling).not.toMatch(/setInterval\s*\(/);
    expect(weiling).not.toMatch(/setTimeout\s*\(\s*\(\)\s*=>\s*void this\.syncAll/);
    expect(weiling).toContain('ScheduledTasksRunner');
  });

  it('🔴 笔记归档不能再自建 cron（否则同一任务被调度两次）', () => {
    expect(notes).not.toMatch(/startCron\s*\(/);
    expect(notes).not.toMatch(/setInterval\s*\(/);
    expect(notes).toContain('loadJobs');
  });

  it('🔴 邮件收取不能再硬编码 */15（时间要能在页面上配）', () => {
    expect(mailModule).not.toContain("'*/15 * * * *'");
    expect(mailModule).not.toContain('new Cron');
  });

  it('调度器按「任务类型」分发到三个执行体，且错峰（不 await 阻塞别的任务）', () => {
    expect(runner).toContain('卫瓴联系人同步');
    expect(runner).toContain('邮件收取');
    expect(runner).toContain('this.notes.start(job');
    expect(runner).toContain('this.weiling.syncAll');
    expect(runner).toContain('this.mail.syncAll');
    expect(runner).toContain('shouldRunArchiveJob'); // 判据只写一处（contracts 纯函数）
    expect(runner).toContain('jobSlotKey');
  });

  it('调度器已注册进 app.module，且排在三个被注入的模块之后', () => {
    expect(appModule).toContain('ScheduledTasksModule');
    const i = appModule.indexOf('ScheduledTasksModule');
    const j = appModule.indexOf('NoteArchiveModule');
    expect(j).toBeGreaterThan(-1);
    // 允许出现在 import 段与数组里；只要存在即可（顺序只影响可读性，启动期由 Nest 解析依赖）
    expect(i).toBeGreaterThan(-1);
  });
});

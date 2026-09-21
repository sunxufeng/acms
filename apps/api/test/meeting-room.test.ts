/**
 * 会议室助手：共用判据测试（2026-09-21）。
 *
 * 这些函数是「时间轴着色」与「找空闲命中」的**同一份实现**，写错不会报错、只会显示错：
 *   - 相邻不算冲突（13:00 结束的会，14:00 就能用同一间）—— 写成带等号的判据会变成
 *     「上一场刚结束，却说没有可用会议室」；
 *   - 时间轴格数与窗口必须自洽（少一格/多一格都会让人误判某小时）；
 *   - 层级树解析要处理「父级缺失」（飞书只返回有权限看到的层级）——
 *     判成非根的话，楼栋筛选里会出现空名或把楼层当楼栋。
 */
import { describe, expect, it } from 'vitest';
import { inheritModulePermissions } from '@acms/domain';
import {
  MEETING_BUCKET_COUNT,
  MEETING_BUCKET_MS,
  MEETING_DAY_END_HOUR,
  MEETING_DAY_START_HOUR,
  MEETING_ROOM_SCOPES,
  MODULE_RESOURCE_INTRODUCED_VERSION,
  ROLE_PERMISSION_VERSION,
  bucketize,
  dayWindow,
  hhmm,
  hhmmToMs,
  isSlotFree,
  meetingRoomAuthUrl,
  mergeBusySpans,
  nowProgress,
  resolveLevelNames,
  resourceKeysIntroducedAfter,
  shiftDateKey,
  spanOverlaps,
  todayKey,
  type MeetingRoomLevel,
} from '@acms/contracts';

const H = 3600_000;
/** 造一个本地时间的毫秒（避免用 UTC 字符串在 CI 时区下飘） */
const at = (d: string, h: number, m = 0) => {
  const [y, mo, dd] = d.split('-').map(Number);
  return new Date(y as number, (mo as number) - 1, dd as number, h, m, 0, 0).getTime();
};

describe('区间冲突判据', () => {
  it('真重叠算冲突', () => {
    expect(spanOverlaps(at('2026-09-21', 10), at('2026-09-21', 11), at('2026-09-21', 10, 30), at('2026-09-21', 12))).toBe(true);
  });

  it('🔴 相邻不算冲突（13:00 结束 → 14:00 可用同一间）', () => {
    expect(spanOverlaps(at('2026-09-21', 13), at('2026-09-21', 14), at('2026-09-21', 14), at('2026-09-21', 16))).toBe(false);
  });

  it('完全错开不算冲突', () => {
    expect(spanOverlaps(at('2026-09-21', 8), at('2026-09-21', 9), at('2026-09-21', 10), at('2026-09-21', 11))).toBe(false);
  });

  it('被完全包含算冲突', () => {
    expect(spanOverlaps(at('2026-09-21', 9), at('2026-09-21', 18), at('2026-09-21', 12), at('2026-09-21', 13))).toBe(true);
  });

  it('isSlotFree：无占用即空闲', () => {
    expect(isSlotFree([], at('2026-09-21', 14), at('2026-09-21', 16))).toBe(true);
  });

  it('isSlotFree：有一场真重叠就不空闲', () => {
    const busy = [{ startMs: at('2026-09-21', 15), endMs: at('2026-09-21', 15, 30) }];
    expect(isSlotFree(busy, at('2026-09-21', 14), at('2026-09-21', 16))).toBe(false);
  });

  it('isSlotFree：前面那场 13:00–14:00 不挡 14:00–16:00', () => {
    const busy = [{ startMs: at('2026-09-21', 13), endMs: at('2026-09-21', 14) }];
    expect(isSlotFree(busy, at('2026-09-21', 14), at('2026-09-21', 16))).toBe(true);
  });
});

describe('mergeBusySpans（渲染用）', () => {
  it('重叠合并成一段', () => {
    const out = mergeBusySpans([
      { startMs: at('2026-09-21', 9), endMs: at('2026-09-21', 10) },
      { startMs: at('2026-09-21', 9, 30), endMs: at('2026-09-21', 11) },
    ]);
    expect(out).toEqual([{ startMs: at('2026-09-21', 9), endMs: at('2026-09-21', 11) }]);
  });

  it('相邻合并成一段（视觉上连成一片，不影响冲突判据）', () => {
    const out = mergeBusySpans([
      { startMs: at('2026-09-21', 9), endMs: at('2026-09-21', 10) },
      { startMs: at('2026-09-21', 10), endMs: at('2026-09-21', 11) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.endMs).toBe(at('2026-09-21', 11));
  });

  it('乱序输入按开始时间排好', () => {
    const out = mergeBusySpans([
      { startMs: at('2026-09-21', 15), endMs: at('2026-09-21', 16) },
      { startMs: at('2026-09-21', 9), endMs: at('2026-09-21', 10) },
    ]);
    expect(out.map((s) => s.startMs)).toEqual([at('2026-09-21', 9), at('2026-09-21', 15)]);
  });

  it('丢弃非法片段（end ≤ start / 非数字）——上游脏数据不该画出负长度的块', () => {
    const out = mergeBusySpans([
      { startMs: at('2026-09-21', 10), endMs: at('2026-09-21', 10) },
      { startMs: Number.NaN, endMs: at('2026-09-21', 12) },
      { startMs: at('2026-09-21', 13), endMs: at('2026-09-21', 14) },
    ]);
    expect(out).toEqual([{ startMs: at('2026-09-21', 13), endMs: at('2026-09-21', 14) }]);
  });
});

describe('时间轴分桶', () => {
  const win = dayWindow('2026-09-21');

  it('窗口就是 08:00–22:00，格数 = 14', () => {
    expect(hhmm(win.startMs)).toBe('08:00');
    expect(hhmm(win.endMs)).toBe('22:00');
    expect(bucketize([], win.startMs, win.endMs)).toHaveLength(MEETING_BUCKET_COUNT);
    expect(MEETING_BUCKET_COUNT).toBe(MEETING_DAY_END_HOUR - MEETING_DAY_START_HOUR);
  });

  it('格数由窗口与粒度算出，不受数据影响', () => {
    const cells = bucketize([{ startMs: at('2026-09-21', 9), endMs: at('2026-09-21', 9, 30) }], win.startMs, win.endMs);
    expect(cells).toHaveLength(MEETING_BUCKET_COUNT);
  });

  it('占用落在哪一格：9:00–9:30 只占第 2 格（8–9、9–10 里的 9–10 那格）', () => {
    const cells = bucketize([{ startMs: at('2026-09-21', 9), endMs: at('2026-09-21', 9, 30) }], win.startMs, win.endMs);
    expect(cells[0]).toBe(false); // 08–09
    expect(cells[1]).toBe(true); // 09–10
    expect(cells[2]).toBe(false); // 10–11
  });

  it('🔴 窗口外的占用（7:00–9:00 的会）也要标到第 1 格 —— 否则会显示成"8 点空闲"', () => {
    const cells = bucketize([{ startMs: at('2026-09-21', 7), endMs: at('2026-09-21', 9) }], win.startMs, win.endMs);
    expect(cells[0]).toBe(true);
    expect(cells[1]).toBe(false);
  });

  it('跨整天的占用会把所有格子标满', () => {
    const cells = bucketize([{ startMs: at('2026-09-21', 0), endMs: at('2026-09-22', 0) }], win.startMs, win.endMs);
    expect(cells.every(Boolean)).toBe(true);
  });

  it('空窗口/非法粒度返回空数组（不崩）', () => {
    expect(bucketize([], win.endMs, win.startMs)).toEqual([]);
    expect(bucketize([], win.startMs, win.endMs, 0)).toEqual([]);
  });
});

describe('时间与日期工具', () => {
  it('hhmmToMs：合法值', () => {
    expect(hhmmToMs('2026-09-21', '14:30')).toBe(at('2026-09-21', 14, 30));
  });

  it('hhmmToMs：非法值返回 NaN（调用方据此报 400，不静默当成 0 点）', () => {
    expect(Number.isNaN(hhmmToMs('2026-09-21', '14:7'))).toBe(true);
    expect(Number.isNaN(hhmmToMs('2026-09-21', '25:00'))).toBe(true);
    expect(Number.isNaN(hhmmToMs('2026-09-21', ''))).toBe(true);
    expect(Number.isNaN(hhmmToMs('乱写', '10:00'))).toBe(true);
  });

  it('shiftDateKey 跨月与跨年', () => {
    expect(shiftDateKey('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDateKey('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('todayKey 是本地日期（不是 UTC —— 否则晚上 8 点后会跳到第二天）', () => {
    const d = new Date(2026, 8, 21, 23, 30);
    expect(todayKey(d)).toBe('2026-09-21');
  });

  it('nowProgress：窗口内是比例，窗口外是 null（不画"现在"竖线）', () => {
    const win = dayWindow('2026-09-21');
    expect(nowProgress(win.startMs, win.endMs, win.startMs)).toBe(0);
    expect(nowProgress(win.startMs, win.endMs, at('2026-09-21', 15))).toBeCloseTo(0.5, 5);
    expect(nowProgress(win.startMs, win.endMs, at('2026-09-21', 7))).toBeNull();
    expect(nowProgress(win.startMs, win.endMs, at('2026-09-21', 23))).toBeNull();
  });

  it('粒度常量与窗口自洽（改一个忘一个的话这条会红）', () => {
    expect(MEETING_BUCKET_MS).toBe(H);
    expect(MEETING_BUCKET_COUNT * MEETING_BUCKET_MS).toBe(dayWindow('2026-09-21').endMs - dayWindow('2026-09-21').startMs);
  });
});

describe('层级树 → 楼栋 / 楼层', () => {
  const levels: MeetingRoomLevel[] = [
    { levelId: 'L1', name: '教学楼', parentId: '', path: ['L1'] },
    { levelId: 'L1F2', name: '2F', parentId: 'L1', path: ['L1', 'L1F2'] },
    { levelId: 'L2', name: '行政楼', parentId: '', path: ['L2'] },
    // 父级缺失：飞书只返回有权限看到的层级 ⇒ 必须当成根，否则楼栋名为空
    { levelId: 'L9F1', name: '1F', parentId: 'MISSING', path: ['L9F1'] },
  ];

  it('两级：楼层上溯到楼栋', () => {
    const m = resolveLevelNames(levels);
    expect(m.get('L1F2')).toEqual({ rootName: '教学楼', floorName: '2F' });
  });

  it('房间直接挂在一级层级上时，楼层为空（不显示「教学楼 · 教学楼」）', () => {
    const m = resolveLevelNames(levels);
    expect(m.get('L1')).toEqual({ rootName: '教学楼', floorName: '' });
  });

  it('🔴 父级缺失的层级视为根（否则它的房间没有楼栋）', () => {
    const m = resolveLevelNames(levels);
    expect(m.get('L9F1')).toEqual({ rootName: '1F', floorName: '' });
  });

  it('未知层级 id 返回 undefined（调用方退回「未归属楼栋」）', () => {
    expect(resolveLevelNames(levels).get('NOPE')).toBeUndefined();
  });
});

describe('权限版本迁移（增量，禁止全量重算）', () => {
  it('v5 引入的资源就是会议室助手', () => {
    expect(resourceKeysIntroducedAfter(4)).toContain('meetingRooms');
  });

  it('已是最新版 ⇒ 没有增量（幂等，重复启动不会重复补）', () => {
    expect(resourceKeysIntroducedAfter(ROLE_PERMISSION_VERSION)).toEqual([]);
  });

  it('登记的引入版本不得超过当前版本（写超了会永远不生效）', () => {
    for (const [, v] of Object.entries(MODULE_RESOURCE_INTRODUCED_VERSION)) {
      expect(v).toBeLessThanOrEqual(ROLE_PERMISSION_VERSION);
    }
  });

  it('🔴 增量迁移只补会议室 —— 不能把「只给两个角色」的报表点顺手发出去', () => {
    const role = {
      key: 'PhaseX',
      permissions: ['module:reports:read', 'module:meetingMinutes:read'],
      menus: [] as string[],
    };
    const inc = inheritModulePermissions(role, { onlyKeys: ['meetingRooms'] });
    expect(inc).toContain('module:meetingRooms:read');
    // ↓ 全量重算会按 legacyRead（module:reports:read）把它加进来 —— 2026-09-21 实测过
    expect(inc).not.toContain('module:reportUsage:read');
    // ↓ 也不能顺手补上 AI 路由的 enter（菜单可见性会被意外放大）
    expect(inc.filter((p) => p.startsWith('module:ai'))).toEqual([]);
    // 增量只加不减：原有权限一个都不能少
    for (const p of role.permissions) expect(inc).toContain(p);
  });

  it('增量迁移下管理员也能拿到（否则「同步飞书会议室」点了 403）', () => {
    const inc = inheritModulePermissions(
      { key: '系统管理员', permissions: [], menus: [] },
      { onlyKeys: ['meetingRooms'] },
    );
    expect(inc).toContain('module:meetingRooms:update');
    expect(inc).toContain('module:meetingRooms:enter');
  });

  it('没有 legacy 读点的角色拿不到会议室（保持最小权限，不"默认放开"）', () => {
    const inc = inheritModulePermissions(
      { key: '无权限角色', permissions: [], menus: [] },
      { onlyKeys: ['meetingRooms'] },
    );
    expect(inc).toEqual([]);
  });
});

describe('权限开通链接', () => {
  it('带上会议室只读相关的全部 scope，点进去能一键勾选', () => {
    const url = meetingRoomAuthUrl('cli_abc');
    expect(url).toContain('https://open.feishu.cn/app/cli_abc/auth');
    for (const s of MEETING_ROOM_SCOPES) expect(url).toContain(s);
    expect(MEETING_ROOM_SCOPES.length).toBeGreaterThan(0);
  });
});

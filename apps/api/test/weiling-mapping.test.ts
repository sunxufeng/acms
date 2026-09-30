/**
 * 「卫瓴映射」（v13）的守卫测试。
 *
 * 背景（2026-09-30 峰哥需求）：把「卫瓴取值 → 学生档案选项」的对应关系从
 * `weiling-enroll.ts` 里写死的 const 提成可配置页面，菜单名「卫瓴映射」。
 *
 * 🔴 本文件钉住四类东西：
 *   ① **默认值 = 原常量**（判据参数化的前提：老调用点零改动、零行为变化）
 *   ② 归一化的边界（配置读坏必须还能转档，且"存进去的就是生效的那份"）
 *   ③ 权限点形状（`legacyRead: null` + `actions` **恰为** `['read','update']`）
 *      —— `enter` 会被无条件发给全站角色，这是 2026-09-30 在 `weilingEnroll` 上踩过的
 *   ④ 页面不许自己算判据（试算必须走服务端同一份）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEILING_MAPPING_CONFIG,
  MODULE_RESOURCES,
  MODULE_RESOURCE_INTRODUCED_VERSION,
  ROLE_PERMISSION_VERSION,
  WEILING_MAPPING_FIELDS,
  WEILING_MAPPING_KEYS,
  WEILING_MAPPING_MENU_KEY,
  buildEnrollDraft,
  enrollWriteFields,
  normalizeWeilingMappingConfig,
  weilingMappedValue,
  weilingMappingChangedKeys,
  weilingMappingInvalid,
  weilingMappingTally,
  weilingMappingVisible,
  weilingValueDistribution,
  type WeilingEnrollContext,
  type WeilingMappingConfig,
} from '@acms/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * 读仓库根目录下的文件。
 *
 * ⚠️ 这里必须是**三级** `..`：`here` = `<repo>/apps/api/test`，
 *    两级只到 `<repo>/apps`（`weiling-enroll.test.ts` 里是两级，因为它传的是 `'api', ...'`；
 *    本文件传的是 `'apps', 'api', ...'`，所以要多退一级）。
 */
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', '..', ...p), 'utf8');

/**
 * 剥注释后再断言。
 * 🔴 本仓反复踩到：`not.toContain` 命中的是**我自己注释里**写的反例写法。
 */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/[^\n]*/g, '');

// ══════════════════════════════════════════════════════════════
// 一、默认值 = 原写死的映射表（零行为变化）
// ══════════════════════════════════════════════════════════════

describe('卫瓴映射 · 默认值等于原常量', () => {
  it('原学校类型 / 计划入读 / 缴费情况 三张表与原 const 逐条一致', () => {
    const d = DEFAULT_WEILING_MAPPING_CONFIG;
    expect(d.schoolType).toEqual({ 体制内: '体制内学校', 国际课程: '国际学校' });
    expect(d.plannedTerm).toEqual({
      '2025年秋季学期': '25秋季',
      '2026年春季学期': '26春季',
      '2026年秋季或后': '26秋季',
      其它: '',
    });
    expect(d.payment).toEqual({ 是: '已付款', 否: '未付款' });
  });

  it('🔴 来源渠道 / 生源跟进状态 默认为**空**（原来就是"不填 + 写理由"）', () => {
    // 默认非空就等于"偷偷替老师做了口径决定" —— 那两条口径只有招生老师知道。
    expect(DEFAULT_WEILING_MAPPING_CONFIG.channel).toEqual({});
    expect(DEFAULT_WEILING_MAPPING_CONFIG.stage).toEqual({});
  });

  it('兜底默认为空（不兜底 = 未配的留空，与原来一致）', () => {
    for (const k of WEILING_MAPPING_KEYS) {
      expect(DEFAULT_WEILING_MAPPING_CONFIG.fallback[k]).toBe('');
    }
  });

  it('元信息覆盖全部映射键，且目标字段名/选项齐备（页面靠它渲染，缺了就少一栏）', () => {
    expect(WEILING_MAPPING_FIELDS.map((f) => f.key)).toEqual([...WEILING_MAPPING_KEYS]);
    for (const f of WEILING_MAPPING_FIELDS) {
      expect(f.weilingLabel, `${f.key} 缺卫瓴字段名`).toBeTruthy();
      expect(f.weilingSource, `${f.key} 没写取值来源`).toBeTruthy();
      expect(f.archiveField, `${f.key} 缺目标字段`).toBeTruthy();
      expect(f.archiveValues.length, `${f.key} 没有任何选项`).toBeGreaterThan(0);
      expect(f.hint, `${f.key} 缺说明`).toBeTruthy();
    }
  });

  it('🔴 档案侧选项必须与字典 key 对得上（来源渠道 / 生源跟进状态 / 入学年月 走字典）', () => {
    const byKey = new Map(WEILING_MAPPING_FIELDS.map((f) => [f.key, f]));
    expect(byKey.get('channel')?.archiveDictKey).toBe('来源渠道');
    expect(byKey.get('stage')?.archiveDictKey).toBe('生源跟进状态');
    expect(byKey.get('plannedTerm')?.archiveDictKey).toBe('入学年月');
    // 兜底清单也必须是**当前字典**的那 8 / 6 项（不是过期快照里的 4 项）
    expect(byKey.get('channel')?.archiveValues).toContain('搜索引擎');
    expect(byKey.get('channel')?.archiveValues).toContain('开放日');
    expect(byKey.get('channel')?.archiveValues).not.toContain('官网咨询');
    expect(byKey.get('stage')?.archiveValues).toContain('已成交');
  });
});

// ══════════════════════════════════════════════════════════════
// 二、归一化与翻译判据
// ══════════════════════════════════════════════════════════════

describe('卫瓴映射 · 归一化（读坏配置必须还能转档）', () => {
  it('垃圾输入不抛错，逐项回落默认', () => {
    for (const bad of [null, undefined, 42, 'x', [], { channel: 'nope' }, { fallback: 7 }]) {
      const c = normalizeWeilingMappingConfig(bad);
      expect(c.schoolType).toEqual(DEFAULT_WEILING_MAPPING_CONFIG.schoolType);
      expect(c.channel).toEqual({});
      expect(c.fallback.channel).toBe('');
    }
  });

  it('丢弃空键、trim 值，保留显式 `""`（= 故意不映射）', () => {
    const c = normalizeWeilingMappingConfig({
      schoolType: { '': '国际学校', ' 体制内  ': '  体制内学校  ', 海外回国: '', 创新学校: null },
    });
    expect(c.schoolType).toEqual({ 体制内: '体制内学校', 海外回国: '', 创新学校: '' });
  });

  it('🔴 `fallback` 缺省时**保留默认**（不能把老配置里已配的兜底抹掉）', () => {
    const c = normalizeWeilingMappingConfig({ channel: { a: '官网' } });
    expect(c.fallback).toEqual(DEFAULT_WEILING_MAPPING_CONFIG.fallback);
  });

  it('changed 只报真正改过的键（含 `fallback.<key>`）', () => {
    expect(weilingMappingChangedKeys(DEFAULT_WEILING_MAPPING_CONFIG)).toEqual([]);
    const c = normalizeWeilingMappingConfig({
      schoolType: DEFAULT_WEILING_MAPPING_CONFIG.schoolType,
      channel: { 小红书: '社交媒体' },
      fallback: { ...DEFAULT_WEILING_MAPPING_CONFIG.fallback, stage: '新线索' },
    });
    expect(weilingMappingChangedKeys(c).sort()).toEqual(['channel', 'fallback.stage']);
  });
});

describe('卫瓴映射 · 翻译顺序（精确 → 兜底 → 空）', () => {
  const cfg: WeilingMappingConfig = normalizeWeilingMappingConfig({
    ...DEFAULT_WEILING_MAPPING_CONFIG,
    channel: { 小红书: '社交媒体', 视频号: '' },
    fallback: { ...DEFAULT_WEILING_MAPPING_CONFIG.fallback, channel: '其他' },
  });

  it('精确命中优先', () => {
    expect(weilingMappedValue(cfg, 'channel', '小红书')).toEqual({ value: '社交媒体', via: 'exact' });
  });

  it('没配 → 走兜底', () => {
    expect(weilingMappedValue(cfg, 'channel', '知乎')).toEqual({ value: '其他', via: 'fallback' });
  });

  it('🔴 显式配成空串 → **不再回落兜底**（那是老师写的"这条就是不映射"）', () => {
    expect(weilingMappedValue(cfg, 'channel', '视频号')).toEqual({ value: '', via: 'exact' });
  });

  it('两边都空 → 留空', () => {
    const noFb = normalizeWeilingMappingConfig({ ...DEFAULT_WEILING_MAPPING_CONFIG, channel: {} });
    expect(weilingMappedValue(noFb, 'channel', '知乎')).toEqual({ value: '', via: 'none' });
  });

  it('前后空白不影响命中（库里脏值常见）', () => {
    expect(weilingMappedValue(cfg, 'channel', ' 小红书 ').value).toBe('社交媒体');
  });
});

describe('卫瓴映射 · 试算与分布', () => {
  it('按"出现条数"加权，未配的只报有量的', () => {
    const cfg = normalizeWeilingMappingConfig({
      ...DEFAULT_WEILING_MAPPING_CONFIG,
      channel: { A: '官网' },
      fallback: { ...DEFAULT_WEILING_MAPPING_CONFIG.fallback, channel: '' },
    });
    const r = weilingMappingTally(cfg, {
      channel: [
        { value: 'A', count: 10 },
        { value: 'B', count: 5 },
        { value: 'C', count: 0 },
      ],
    });
    const ch = r.find((x) => x.key === 'channel')!;
    expect(ch.total).toBe(15);
    expect(ch.mapped).toBe(10);
    expect(ch.unmapped).toEqual(['B']); // C 是 0 条，不算"有量没配"
  });

  it('分布：trim + 合并重复 + 去空值 + 按条数降序', () => {
    const d = weilingValueDistribution([
      { value: ' 小红书 ', count: 2 },
      { value: '小红书', count: 3 },
      { value: '', count: 99 },
      { value: null, count: 99 },
      { value: '知乎', count: 7 },
    ]);
    expect(d).toEqual([
      { value: '知乎', count: 7 },
      { value: '小红书', count: 5 },
    ]);
  });

  it('🔴 invalid：目标值不在档案选项里要**报出来**（不是静默丢掉）', () => {
    const cfg = normalizeWeilingMappingConfig({
      ...DEFAULT_WEILING_MAPPING_CONFIG,
      channel: { 小红书: '社媒' }, // 「社媒」不是选项（正确写法是「社交媒体」）
      fallback: { ...DEFAULT_WEILING_MAPPING_CONFIG.fallback, stage: '不存在的阶段' },
    });
    const bad = weilingMappingInvalid(cfg, {
      channel: WEILING_MAPPING_FIELDS.find((f) => f.key === 'channel')!.archiveValues as string[],
      stage: WEILING_MAPPING_FIELDS.find((f) => f.key === 'stage')!.archiveValues as string[],
    });
    expect(bad.length).toBe(2);
    expect(bad.join(' ')).toContain('社媒');
    expect(bad.join(' ')).toContain('不存在的阶段');
  });

  it('合法配置不报 invalid', () => {
    const allowed: Record<string, string[]> = {};
    for (const f of WEILING_MAPPING_FIELDS) allowed[f.key] = [...f.archiveValues];
    expect(weilingMappingInvalid(DEFAULT_WEILING_MAPPING_CONFIG, allowed)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// 三、转档草稿真的会跟着配置变（这是"配置有没有生效"的实质判据）
// ══════════════════════════════════════════════════════════════

function ctxOf(over: Partial<WeilingEnrollContext> = {}): WeilingEnrollContext {
  return {
    contactName: '丁点儿-万美妗妈妈转介绍',
    studentNameRaw: '万美妗',
    ownerName: '致极学院-曹老师｜Dainel',
    recruiterOpenId: 'ou_x',
    recruiterName: '曹德强',
    school: '某中学',
    schoolType: '国际课程',
    plannedTerm: '2026年春季学期',
    paid: '是',
    mobile: '13800000000',
    channel: '活动-公众号',
    customerStage: '面访',
    // 🔴 不能省：`buildEnrollRemark` 会对它调 `.filter()`（漏了就是 TypeError，
    //    而报错点在 contracts 里、看起来像"实现坏了"，实际是测试上下文不完整）
    marketing: [
      { label: '客户阶段', value: '面访' },
      { label: '来源渠道', value: '活动-公众号' },
    ],
    createdAt: 1_750_000_000_000,
    operatorName: '测试',
    now: 1_760_000_000_000,
    ...over,
  };
}

describe('卫瓴映射 · 转档草稿跟着配置变', () => {
  it('默认配置下：来源渠道 / 生源跟进状态 是 skip 档（= 上线前后行为不变）', () => {
    const d = buildEnrollDraft(ctxOf());
    const ch = d.fields.find((f) => f.key === '来源渠道')!;
    const st = d.fields.find((f) => f.key === '生源跟进状态')!;
    expect(ch.tier).toBe('skip');
    expect(ch.value).toBe('');
    expect(ch.why).toContain('卫瓴映射'); // 要指路到配置页，而不是干巴巴"跳过"
    expect(st.tier).toBe('skip');
    // 🔴 但**保持可编辑** —— 留空 ≠ 禁用（用户可以在弹窗里手选）
    expect(ch.editable).toBe(true);
    expect(st.editable).toBe(true);
  });

  it('配了映射之后：两栏变成 check 档并带上翻译好的值', () => {
    const cfg = normalizeWeilingMappingConfig({
      ...DEFAULT_WEILING_MAPPING_CONFIG,
      channel: { '活动-公众号': '活动招募' },
      stage: { 面访: '跟进中' },
    });
    const d = buildEnrollDraft(ctxOf(), cfg);
    const ch = d.fields.find((f) => f.key === '来源渠道')!;
    const st = d.fields.find((f) => f.key === '生源跟进状态')!;
    expect(ch.tier).toBe('check');
    expect(ch.value).toBe('活动招募');
    expect(st.tier).toBe('check');
    expect(st.value).toBe('跟进中');
  });

  it('走兜底要**说出来**（否则老师以为配准了）', () => {
    const cfg = normalizeWeilingMappingConfig({
      ...DEFAULT_WEILING_MAPPING_CONFIG,
      fallback: { ...DEFAULT_WEILING_MAPPING_CONFIG.fallback, channel: '其他' },
    });
    const ch = buildEnrollDraft(ctxOf(), cfg).fields.find((f) => f.key === '来源渠道')!;
    expect(ch.value).toBe('其他');
    expect(`${ch.source}${ch.why}`).toContain('兜底');
  });

  it('显式配成"不映射"时的理由与"还没配"**必须区分**（处理建议不同）', () => {
    const cfg = normalizeWeilingMappingConfig({
      ...DEFAULT_WEILING_MAPPING_CONFIG,
      channel: { '活动-公众号': '' },
    });
    const explicit = buildEnrollDraft(ctxOf(), cfg).fields.find((f) => f.key === '来源渠道')!;
    expect(explicit.why).toContain('显式设为不映射');
    const absent = buildEnrollDraft(ctxOf()).fields.find((f) => f.key === '来源渠道')!;
    expect(absent.why).toContain('还没配映射');
    expect(absent.why).toContain('卫瓴映射');
  });

  it('运行期选项（字典）优先于出厂清单', () => {
    const d = buildEnrollDraft(ctxOf({ archiveOptions: { channel: ['只有这一项'] } }));
    const ch = d.fields.find((f) => f.key === '来源渠道')!;
    expect(ch.options).toEqual(['只有这一项']);
  });

  it('三处原有映射也走同一份配置（改配置能覆盖学校类型）', () => {
    const cfg = normalizeWeilingMappingConfig({
      ...DEFAULT_WEILING_MAPPING_CONFIG,
      schoolType: { 国际课程: '体制内学校' }, // 故意反着配，验证真的读了配置
    });
    const f = buildEnrollDraft(ctxOf(), cfg).fields.find((x) => x.key === '原学校类型')!;
    expect(f.value).toBe('体制内学校');
  });
});

describe('卫瓴映射 · 写库规则（skip 分两种）', () => {
  it('🔴 `skip` + `editable` 的字段：手选了就写（老写法 skip 一律 continue 会静默丢弃）', () => {
    const d = buildEnrollDraft(ctxOf());
    const out = enrollWriteFields(d, {}, { 来源渠道: '其他' });
    expect(out['来源渠道']).toBe('其他');
  });

  it('🔴 `skip` + 不可编辑 的字段：连人工都不给写（学生手机号 / 学生邮箱 / 当前年级）', () => {
    const d = buildEnrollDraft(ctxOf());
    const out = enrollWriteFields(d, {}, { 学生手机号: '13800000000', 学生邮箱: 'a@b.com', 当前年级: 'G10' });
    expect(out['学生手机号']).toBeUndefined();
    expect(out['学生邮箱']).toBeUndefined();
    expect(out['当前年级']).toBeUndefined();
  });

  it('没手选时那两栏不写（配置没配 → 不落脏值）', () => {
    const out = enrollWriteFields(buildEnrollDraft(ctxOf()), {}, {});
    expect(out['来源渠道']).toBeUndefined();
    expect(out['生源跟进状态']).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 四、权限点与菜单
// ══════════════════════════════════════════════════════════════

describe('卫瓴映射 · 权限点', () => {
  const res = MODULE_RESOURCES.find((r) => r.key === 'weilingMapping');

  it('资源已声明，且是"不随迁移发放"的配置类权限点', () => {
    expect(res, 'MODULE_RESOURCES 里没有 weilingMapping').toBeTruthy();
    expect(res?.legacyRead).toBeNull();
    expect(res?.legacyWrite).toBeNull();
    expect(res?.menuPermission).toBeNull();
    expect(res?.path).toBe('/weiling-mapping'); // 有真实页面 ⇒ 真 path
    expect(res?.subOf).toBeUndefined(); // 自己有菜单项，不挂在别人下面
  });

  it('🔴🔴 actions 必须**恰好**是 read + update，不得含 `enter`（会被无条件发给全站）', () => {
    // 2026-09-30 实测：`weilingEnroll` 用了 `[...READ,'update']`（READ 含 enter）⇒
    // `module:weilingEnroll:enter` 被 12 个角色持有（含 student / parent）。
    // 根因：inheritModulePermissions 对 enter 走另一套判据，
    // `menuPermission: null` ⇒ `(!menuPermission || …)` 恒真 ⇒ 无条件发放。
    expect([...(res?.actions ?? [])].sort()).toEqual(['read', 'update']);
  });

  it('引入版本已登记，且 == 当前权限版本（否则增量迁移覆盖不到它）', () => {
    // ⚠️ 不写 `toBe(ROLE_PERMISSION_VERSION)`：那条等式只在"引入它的那次发布"成立，
    //    下次抬版本必红。不变式是 **引入版本 ≤ 当前版本**（不能是未来的版本）。
    const v = MODULE_RESOURCE_INTRODUCED_VERSION['weilingMapping'];
    expect(v).toBeGreaterThanOrEqual(13); // v13 引入，不许改小（改小 = 又给存量角色发一遍）
    expect(v).toBeLessThanOrEqual(ROLE_PERMISSION_VERSION);
    expect(ROLE_PERMISSION_VERSION).toBeGreaterThanOrEqual(13);
  });

  it('菜单项已声明，可见性判据只认权限点', () => {
    expect(WEILING_MAPPING_MENU_KEY).toBe('weilingMapping');
    expect(weilingMappingVisible(['module:weilingMapping:read'])).toBe(true);
    expect(weilingMappingVisible(['module:weilingContacts:read'])).toBe(false);
    expect(weilingMappingVisible([])).toBe(false);
    expect(weilingMappingVisible(undefined)).toBe(false);
  });

  it('菜单配置里有这条（key 与资源 key 一致，否则拼出的权限点不存在）', () => {
    const hp = read('packages', 'contracts', 'src', 'homepage.ts');
    const item = hp.split('\n').find((l) => l.includes("key: 'weilingMapping'"));
    expect(item, 'homepage.ts 里没有 weilingMapping 菜单项').toBeTruthy();
    expect(item).toContain("href: '/weiling-mapping'");
    expect(item).toContain("section: '后台管理'");
    // perm 留空 ⇒ 可见性收口在 weilingMappingVisible
    expect(item).toContain("perm: ''");
  });

  it('与「联系人转学生档案」是两个独立权限点（能转档 ≠ 能改全局口径）', () => {
    const enroll = MODULE_RESOURCES.find((r) => r.key === 'weilingEnroll');
    expect(enroll).toBeTruthy();
    expect(enroll?.key).not.toBe('weilingMapping');
    expect(enroll?.legacyRead).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// 五、接口与页面守卫（源码级）
// ══════════════════════════════════════════════════════════════

/** 取一段源码的窗口（剥注释后） */
function upto(src: string, sig: string): string {
  const i = src.indexOf(sig);
  expect(i, `找不到：${sig}`).toBeGreaterThan(-1);
  return strip(src.slice(i));
}

describe('卫瓴映射 · 后端接线', () => {
  const svc = strip(read('apps', 'api', 'src', 'weiling', 'weiling.service.ts'));
  const ctl = strip(read('apps', 'api', 'src', 'weiling', 'weiling.controller.ts'));
  const mod = strip(read('apps', 'api', 'src', 'weiling', 'weiling.module.ts'));

  it('三个接口都判**独立权限点**（不是 weilingContacts 的读写）', () => {
    expect(svc).toContain("requireModule(user, 'weilingMapping', 'read')");
    expect(svc).toContain("requireModule(user, 'weilingMapping', 'update')");
  });

  it('路由齐备，且都是静态路由（排在带参数的路由之前）', () => {
    expect(ctl).toContain("@Get('mapping')");
    expect(ctl).toContain("@Post('mapping/preview')");
    expect(ctl).toContain("@Put('mapping')");
    const iMapping = ctl.indexOf("@Get('mapping')");
    const iParam = ctl.indexOf("@Get('contacts/:id");
    expect(iMapping).toBeGreaterThan(-1);
    if (iParam > -1) expect(iMapping, '静态路由必须排在带参数路由之前').toBeLessThan(iParam);
  });

  it('读配置**永不抛错**（配置读坏必须还能转档）', () => {
    const body = upto(svc, 'async loadEnrollMapping(');
    expect(body).toContain('catch');
    expect(body).toContain('DEFAULT_WEILING_MAPPING_CONFIG');
  });

  it('保存前先归一化（存进去的就是生效的那份）', () => {
    const body = upto(svc, 'async mappingSave(');
    expect(body).toContain('normalizeWeilingMappingConfig(body)');
    expect(body.indexOf('normalizeWeilingMappingConfig(body)')).toBeLessThan(body.indexOf('createWithId'));
  });

  it('转档真的读配置（不是只做给页面看）', () => {
    const body = upto(svc, 'private async enrollContextOf(');
    expect(body).toContain('loadEnrollMapping()');
    expect(body).toContain('buildEnrollDraft(ctx, mapping)');
  });

  it('🔴 DictModule 已 import 且写进 imports 数组（漏了只有装配期才炸）', () => {
    expect(mod).toContain('DictModule');
    const arr = /imports\s*:\s*\[([\s\S]*?)\]/.exec(mod);
    expect(arr, '找不到 imports 数组').toBeTruthy();
    expect(arr![1]).toContain('DictModule');
  });
});

describe('卫瓴映射 · 前端页面', () => {
  const page = strip(read('apps', 'web', 'app', 'weiling-mapping', 'page.tsx'));
  const api = strip(read('apps', 'web', 'lib', 'api.ts'));
  const shell = strip(read('apps', 'web', 'components', 'AppShell.tsx'));

  it('🔴 页面**不许自己算判据**：试算必须调服务端同一份', () => {
    // 本仓踩过"前端照抄判据估出 8 人、线上 42 人"的坑 ⇒ 前端出现这些名字就是走回头路
    expect(page).not.toContain('buildEnrollDraft');
    expect(page).not.toContain('weilingMappedValue');
    expect(page).not.toContain('WEILING_MAPPING_FIELDS');
  });

  it('页面调的是两个真接口（读 + 试算 + 存）', () => {
    expect(page).toContain('api.weilingMappingGet()');
    expect(page).toContain('api.weilingMappingPreview(');
    expect(page).toContain('api.weilingMappingSave(');
  });

  it('api.ts 三个方法的路径与后端一致', () => {
    expect(api).toContain("request<WeilingMappingResult>('/weiling/mapping')");
    expect(api).toContain("'/weiling/mapping/preview'");
  });

  it('菜单可见性已接进 AppShell（漏了 ⇒ 菜单永远不显示且不报错）', () => {
    expect(shell).toContain('WEILING_MAPPING_MENU_KEY');
    expect(shell).toContain('weilingMappingVisible(myPerms)');
  });

  it('🔴 选项不在前端再抄一份（下拉候选必须来自服务端返回的 archiveOptions）', () => {
    // 抄一份的后果：老师改了字典，页面还按旧清单渲染 ⇒ 选了个字典里没有的值
    expect(page).toContain('archiveOptions');
    expect(page).not.toContain("'搜索引擎'");
    expect(page).not.toContain("'开放日'");
  });
});

// ══════════════════════════════════════════════════════════════
// 六、二期：学生详情页「招生来源」（反查）
// ══════════════════════════════════════════════════════════════

describe('招生来源 · 学生详情页反查', () => {
  const svc2 = strip(read('apps', 'api', 'src', 'weiling', 'weiling.service.ts'));
  const ctl2 = strip(read('apps', 'api', 'src', 'weiling', 'weiling.controller.ts'));
  const detail = strip(read('apps', 'web', 'app', 'students', '[id]', 'page.tsx'));

  it('是**反查**（不在学生档案里再存一份来源）', () => {
    const body = svc2.slice(svc2.indexOf('async sourceOfStudent('));
    // 扫联系人表比对 `关联学生ID` —— 关系的事实来源只有一处
    expect(body).toContain("f['关联学生ID']");
    expect(body).toContain('weilingContact');
  });

  it('🔴 只判 `students:read`（看学生的人就该看到"他来自哪"）', () => {
    const body = svc2.slice(svc2.indexOf('async sourceOfStudent('));
    expect(body).toContain("requireModule(user, 'students', 'read')");
    // 不该额外要求联系人权限（那会让卡片对多数老师永远空白）
    expect(body).not.toContain("requireModule(user, 'weilingContacts'");
  });

  it('🔴 返回里**不含联系方式**（手机号/邮箱属联系人模块的数据）', () => {
    // ⚠️ 切片终点必须用**代码**锚点，不能用注释锚点 —— `svc2` 是剥过注释的，
    //    `indexOf('// ═══')` 会返回 -1，`slice(i, -1)` 于是把后面整段都框进来
    //    （第一次就踩了这个：匹配到了 `enrollContextOf` 里的 `mobile:`，假红）。
    const from = svc2.indexOf('async sourceOfStudent(');
    const to = svc2.indexOf('MAPPING_KEY', from);
    const body = svc2.slice(from, to > from ? to : from + 4000);
    expect(body).not.toContain("f['手机号']");
    expect(body).not.toContain("f['邮箱']");
    expect(body).not.toContain('mobile:');
  });

  it('路由是静态路由（排在带参数路由之前）', () => {
    const i = ctl2.indexOf("@Get('students/:studentId/source')");
    expect(i).toBeGreaterThan(-1);
  });

  it('前端详情页真的有这张卡片，且调的是新接口', () => {
    // ⚠️ 页面里是链式写法（`api\n  .weilingStudentSource(id)`），别断言整串
    expect(detail).toContain('.weilingStudentSource(id)');
    expect(detail).toContain("t('admissionSource')");
    // 拉不到不许把整页打挂（它不是主体信息）
    expect(detail).toContain('catch(() => setSources([]))');
  });

  it('文案 key 齐（中英都要有）', () => {
    const zh = JSON.parse(read('apps', 'web', 'messages', 'zh.json')) as Record<string, Record<string, string>>;
    const en = JSON.parse(read('apps', 'web', 'messages', 'en.json')) as Record<string, Record<string, string>>;
    for (const k of ['admissionSource', 'sourceLoading', 'noAdmissionSource', 'sourceScore']) {
      expect(zh['students']?.[k], `zh 缺 ${k}`).toBeTruthy();
      expect(en['students']?.[k], `en 缺 ${k}`).toBeTruthy();
    }
  });
});

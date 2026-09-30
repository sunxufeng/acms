import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「保存原始音频」进度接口的三处一致性守卫（2026-09-30 新增）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────
 * 同一份进度结构散在**三个地方**，少同步一处就出静默 bug：
 *   ① 后端 service `refetchAudioStatus()`（默认值 + 读哪个 job）
 *   ② 后端 service `runScheduledAudioRefetch()`（定时任务写哪个 key）
 *   ③ 前端 `RefetchAudioProgress` 类型（页面按它渲染）
 *
 * 2026-09-30 线上验证时踩到两处：
 *   · 空进度的默认值只回 7 个字段，缺 `noCred` / `trigger` —— 而前端把它们当必填
 *     ⇒ 类型在骗人，页面上「选不到凭证」永远是 `undefined`（显示成 0，看不出是"真 0"还是"没这个字段"）。
 *   · 定时补抓的进度存在 `audio:__cron__`（没有"某个人"），而 status 只读 `audio:<openId>`。
 *     ⇒ 在「定时任务」页点「运行」，提示"进度见「我的笔记」页"，而那一页**永远是空的**。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const svc = read('api', 'src', 'getnote', 'getnote.service.ts');
const api = read('web', 'lib', 'api.ts');

/**
 * 剥掉注释。
 * 🔴 必须剥：本守卫要在源码里数 `audio:__cron__` 出现的次数，
 *    而**注释里为了讲清规矩必然写出这个字面量**（我就在 refetchAudioStatus 的
 *    JSDoc 里写了它）⇒ 不剥的话计数永远多 1，断言永远红。
 *    这是本仓反复踩到的同一类问题：`not.toContain` / 计数类断言前先剥注释。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/[^\n]*/g, '');
}

/** 取某个方法体（从 `sig` 起，到**紧邻的下一个**同级方法定义前） */
function bodyOf(src: string, sig: string, nextSig: string): string {
  const i = src.indexOf(sig);
  expect(i, `找不到方法：${sig}`).toBeGreaterThan(-1);
  const j = src.indexOf(nextSig, i + sig.length);
  expect(j, `找不到下一个方法：${nextSig}`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('音频补抓进度 · 三处一致性', () => {
  it('🔴 status 的空进度兜底必须带上 `noCred`（前端把它当必填，缺了就是类型骗人）', () => {
    const body = bodyOf(svc, 'async refetchAudioStatus(', 'private async runRefetchAudio(');
    expect(body).toContain('noCred');
    expect(body).toContain('running: false');
  });

  it('🔴 status 必须能看见**定时任务**那次（否则「定时任务」页点运行后，「我的笔记」页永远是空的）', () => {
    const body = bodyOf(svc, 'async refetchAudioStatus(', 'private async runRefetchAudio(');
    // 定时任务写的 key 与 status 回落的 key 必须是同一个字面量
    expect(svc, '定时补抓的进度 key 变了？').toContain('audio:__cron__');
    expect(body).toContain("audio:__cron__");
    // 先看自己的、再看定时任务那份（顺序有意义：自己的任务更贴近用户刚点的操作）
    expect(body.indexOf('audio:${user.openId}')).toBeLessThan(body.indexOf("audio:__cron__"));
  });

  it('定时补抓与手动补抓用**不同**的 key（否则两者会互相顶掉 running 标记）', () => {
    const sch = bodyOf(svc, 'async runScheduledAudioRefetch(', 'async refetchAudioStatus(');
    expect(sch).toContain("'audio:__cron__'");
    // 手动那支必须用 openId，且不得碰 cron 的 key
    const manual = bodyOf(svc, 'async startRefetchAudio(', 'async runScheduledAudioRefetch(');
    expect(manual).toContain('openId');
    expect(manual).not.toContain('audio:__cron__');
  });

  it('🔴 定时补抓必须接受 `onDone` 回调（不传就写不回「上次运行详情」）', () => {
    const sch = bodyOf(svc, 'async runScheduledAudioRefetch(', 'async refetchAudioStatus(');
    expect(sch).toContain('onDone');
    expect(sch).toContain("trigger: 'cron'");
    // 成功与异常两条路径都要回调，否则失败了任务行里什么都不显示
    expect(sch.match(/onDone\?\.\(job\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('前端 `RefetchAudioProgress` 与后端字段对齐（noCred / trigger 都在）', () => {
    const i = api.indexOf('interface RefetchAudioProgress');
    expect(i, '前端没有 RefetchAudioProgress 类型了？').toBeGreaterThan(-1);
    const iface = api.slice(i, api.indexOf('}', api.indexOf('{', i)) + 1);
    for (const f of ['noCred', 'trigger', 'running', 'total', 'done', 'stored', 'skipped', 'failed', 'bytes']) {
      expect(iface, `前端类型缺字段 ${f}`).toContain(f);
    }
  });

  it('🔴 定时任务的进度 key 只在「写侧 + 读侧回落」两处出现（拼错就是静默失灵）', () => {
    const hits = [...stripComments(svc).matchAll(/audio:__cron__/g)].length;
    expect(hits, '期望 2 处：runScheduledAudioRefetch 写入 1 处 + refetchAudioStatus 回落 1 处').toBe(2);
  });
});

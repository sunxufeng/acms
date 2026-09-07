import { Inject, Injectable, Logger, HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { TABLES } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { encryptSecret } from '../ai/lib/crypto/kms.js';
import { BaseRecordService } from '../shared/generic-crud.module.js';
import { buildFilter } from '../shared/record.util.js';
import { GETNOTE_SOURCE_META } from './sources.meta.js';
import { GetnoteService } from './getnote.service.js';
// 凭证解码 / 启用判定 / 取纯文本 三个能力下沉到 source-cred.ts：
// GetnoteService 做管理员聚合时也要用，但反向 import SourcesService 会循环依赖。
// 这里以别名引回来，保持本文件内调用点零改动，同时消除两份实现（密钥算法漂移风险）。
import {
  decodeSourceCred as decodeCred,
  isEnabledStatus as isEnabled,
  plainText,
} from './source-cred.js';

/**
 * 笔记来源类型 → 凭证字段名（飞书 Base 里都存在「凭证」文本字段，存的是密文 JSON）。
 * 不同源的凭证结构不同：得到大脑需要 clientId/apiKey，飞书秒记未来可能用 tenantToken 等。
 * 现在只有得到大脑一种，分支结构为后续扩展留好位置。
 */
const SOURCE_CRED_KEYS: Record<string, string[]> = {
  得到大脑: ['apiKey', 'clientId'],
};

/**
 * 「收取频率」的中文字面值 → cron 表达式。
 * 每 15/30 分钟用步长语法，每小时走 0 分，每天固定 03:00 跑一次。
 * 与 mail-archive 模式一致：cron 表达式由「收取频率」字段值动态映射。
 */
const FREQ_TO_CRON: Record<string, string> = {
  每15分钟: '*/15 * * * *',
  每30分钟: '*/30 * * * *',
  每小时: '0 * * * *',
  每天: '0 3 * * *',
};

/** 解析「收取频率」成 cron 表达式；未识别兜底为每小时 */
function freqToCron(v: unknown): string {
  const s = String(v ?? '').trim();
  return FREQ_TO_CRON[s] ?? '0 * * * *';
}

/**
 * 单次同步最多新建多少条「笔记配置映射」。
 *
 * ⚠️ 为什么要有上限：BaseClient **没有 batch 写入**（飞书 Base 只能一条条 create），
 * 而同步是"全量翻页 + 内存去重"，第一次跑可能几百上千条都是新的。
 * 不限流会把飞书写入 QPS 打满（进而让整张表的读写都变慢），所以单批封顶 200；
 * 超出部分本次跳过，下次同步会自然补上（那时它们仍在"未映射"里）。
 */
const CONFIG_MAP_MAX_CREATE = 200;

/** 把凭证对象加密成信封，再 JSON.stringify 成字符串存入飞书文本字段
 *  （飞书文本字段不能存对象，直接存对象会 1254060 TextFieldConvFail）。 */
function encodeCred(cred: Record<string, string>): unknown {
  return JSON.stringify(encryptSecret(JSON.stringify(cred)));
}

/** 后台同步的实时进度（与 mail-archive 同范式：HTTP 立即返回，后台轮询） */
export interface SourceSyncProgress {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  stored: number;
  /** 新建笔记数（已存在的视为已同步，跳过） */
  created: number;
  /** 当前正在跑的配置名称 */
  sourceName: string;
  error?: string;
  result?: string;
}

/**
 * 知识库配置：继承 BaseRecordService 实现标准 CRUD，加密「凭证」字段；
 * 同时承担同步调度的执行体（testSource / syncSource / getSyncStatus）。
 *
 * ⚠️ 凭证存储：复用 ai/lib/crypto/kms（ACAILY_MASTER_KEY 信封加密），
 * 与 getnote/credential.ts 的 user 凭证走同一套加密基建，密钥不变。
 */
@Injectable()
export class GetnoteSourceService extends BaseRecordService {
  private readonly logger = new Logger('GetnoteSource');

  /** 同步任务实时进度（按 recordId 缓存，最近一次任务的状态）。前端轮询取这个。 */
  private readonly syncStates = new Map<string, SourceSyncProgress>();

  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
    @Inject(GetnoteService) private readonly getnote: GetnoteService,
  ) {
    super(GETNOTE_SOURCE_META, base, audit);
  }

  // ── 归属：行级隔离 ────────────────────────────────────────────────
  //
  // 「知识库配置」原本没有任何归属概念 —— GETNOTE_SOURCE_META 没有 ownerField，
  // 通用 CRUD 的 list 只校验 getnote:read 权限点、**不做行级过滤**，
  // 于是任何有权限的人都能看到所有人的配置行（凭证虽置空，配置名却全裸）。
  // 2026-09-07 加了「归属人/归属人ID」两个字段修掉它。

  /** 是否系统管理员（与 homepage-config / user 等模块同一写法） */
  private isAdmin(user: SessionUser): boolean {
    return Boolean(user?.roles?.includes('系统管理员'));
  }

  /**
   * 行级过滤：非管理员只看自己归属的配置。
   *
   * ⚠️ 为什么在这里 override 而不是给 RecordMeta 加通用 ownerField：
   * 通用 CRUD 被十几个模块共用，改它等于全站回归。而这里的现实规模是
   * 「每个用户几条配置」，局部 override 风险可控得多。
   */
  private onlyVisible<T extends Record<string, unknown>>(rows: T[], user: SessionUser): T[] {
    if (this.isAdmin(user)) return rows;
    const me = user?.openId ?? '';
    return rows.filter((r) => plainText(r['归属人ID']) === me);
  }

  /** 非管理员读写他人配置 → 403。配置不存在时不抛（交给上层处理 404）。 */
  private assertOwn(user: SessionUser, rec: Record<string, unknown> | null | undefined): void {
    if (!rec || this.isAdmin(user)) return;
    if (plainText(rec['归属人ID']) !== (user?.openId ?? ''))
      throw new ForbiddenException('FORBIDDEN:not_owner');
  }

  // ── CRUD：覆盖父类以做凭证加密 + 默认值填充 ───────────────────────

  /**
   * 新建配置：把前端传过来的明文凭证字段转成密文后入库；
   * 未填启用状态/收取频率时填默认值。
   */
  async create(user: SessionUser, dto: Record<string, unknown>) {
    const next: Record<string, unknown> = { ...dto };
    if (!next['启用状态']) next['启用状态'] = '启用';
    if (!next['收取频率']) next['收取频率'] = '每小时';
    this.encryptCredInPlace(next);
    // 新建的配置永远归属创建者 —— 管理员也不能「替别人建」，建出来就是自己的
    next['归属人'] = user?.name ?? '';
    next['归属人ID'] = user?.openId ?? '';
    return super.create(user, next);
  }

  /** 编辑：明文凭证字段重新加密；如果是空串/掩码则保留原密文 */
  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    // 先校验归属再动数据，避免「越权者已经改完才被发现」
    this.assertOwn(user, await super.detail(user, id));
    const next: Record<string, unknown> = { ...dto };
    if ('凭证' in next) {
      const v = String(next['凭证'] ?? '').trim();
      if (!v || v === '********') {
        delete next['凭证']; // 不覆盖已有密文
      } else {
        // 解析后重新加密；解析失败说明不是 JSON，包装成单字段
        let cred: Record<string, string>;
        try {
          cred = JSON.parse(v);
        } catch {
          cred = { value: v };
        }
        next['凭证'] = encodeCred(cred);
      }
    }
    if (Object.keys(next).length === 0) return this.detail(user, id);
    return super.update(user, id, next);
  }

  /** 列表：先做行级过滤，再用空串占位「凭证」字段，避免密文外泄 */
  async list(user: SessionUser, query: Record<string, string | undefined>) {
    const res = await super.list(user, query);
    const rows = this.onlyVisible(res.items, user);
    for (const it of rows) {
      it['凭证'] = '';
    }
    // ⚠️ 过滤发生在分页**之后**，所以这里直接把结果收敛成单页：
    // 配置表的现实量级是「每人几条」，一页装得下；若将来真到了几百条
    // 需要服务端分页级过滤的规模，应该在 BaseRecordService 里做通用的 opt-in ownerField。
    return { ...res, items: rows, total: rows.length, hasMore: false, pageToken: undefined };
  }

  async detail(user: SessionUser, id: string) {
    const rec = await super.detail(user, id);
    this.assertOwn(user, rec);
    rec['凭证'] = '';
    return rec;
  }

  /**
   * 新建时加密。调用方传过来的是明文 JSON 或「按 schema 各字段散开」的对象，
   * 我们统一收成 {apiKey, clientId, ...} 后 JSON 序列化再加密。
   */
  private encryptCredInPlace(next: Record<string, unknown>) {
    const raw = next['凭证'];
    let cred: Record<string, string> = {};
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') cred = parsed as Record<string, string>;
      } catch {
        cred = { value: raw };
      }
    } else if (raw && typeof raw === 'object') {
      cred = raw as Record<string, string>;
    }
    // 移除散开的字段（如前端直接把 apiKey/clientId 写在 payload 顶层）
    for (const k of SOURCE_CRED_KEYS['得到大脑'] ?? []) {
      const v = next[k];
      if (typeof v === 'string' && v.trim()) cred[k] = v.trim();
      delete next[k];
    }
    if (Object.keys(cred).length === 0) {
      delete next['凭证'];
      return;
    }
    next['凭证'] = encodeCred(cred);
  }

  /**
   * 取出真实凭证对象（含明文 apiKey/clientId）。仅内部使用，绝不返出 controller。
   */
  async getCredForSync(recordId: string): Promise<{ sourceType: string; cred: Record<string, string> } | null> {
    const rec = await this.base.get(this.meta.tableId, recordId);
    if (!rec) return null;
    const fields = rec.fields as Record<string, unknown>;
    const cred = decodeCred(fields['凭证']);
    const sourceType = plainText(fields['笔记类型']);
    return { sourceType, cred };
  }

  // ── 测试连通性 ────────────────────────────────────────────────────

  /**
   * 触发测试连通性（POST /:id/test）。调用方按行拿到 recordId。
   * 得到大脑：解出 apiKey/clientId 打一次真实的 list 接口，能通就 ok；
   * 其他笔记类型：暂未实现，返回 501 引导用户先选「得到大脑」。
   */
  /**
   * 免 id 测试连通性：前端在「新建/编辑表单」里还没保存就能直接验活凭证。
   * 接收明文 { apiKey, clientId, 笔记类型 }，对接 Get笔记 真实接口探活。
   * 不落库、不加密，仅做连通校验。
   */
  async testCredInput(input: {
    apiKey?: string;
    clientId?: string;
    笔记类型?: string;
  }): Promise<{ ok: boolean; sourceType: string; note: string }> {
    const sourceType = String(input.笔记类型 ?? '').trim();
    if (!sourceType) return { ok: false, sourceType: '', note: '请先选择笔记类型' };
    if (sourceType !== '得到大脑') {
      return { ok: false, sourceType, note: '该笔记类型暂未接入，可先选「得到大脑」' };
    }
    const apiKey = String(input.apiKey ?? '').trim();
    const clientId = String(input.clientId ?? '').trim();
    if (!apiKey || !clientId) {
      return { ok: false, sourceType, note: '请填写 API Key 与 Client ID' };
    }
    try {
      await this.getnote.probeCredentials(apiKey, clientId);
      return { ok: true, sourceType, note: '连通成功' };
    } catch (e) {
      return { ok: false, sourceType, note: (e as Error).message };
    }
  }

  /** 按已保存记录测试连通性（POST /:id/test）。复用免 id 的探活逻辑 */
  async testSource(user: SessionUser, recordId: string): Promise<{
    ok: boolean;
    sourceType: string;
    note: string;
  }> {
    await this.detail(user, recordId); // 顺手校验权限
    const got = await this.getCredForSync(recordId);
    if (!got) throw new HttpException('SOURCE_NOT_FOUND', HttpStatus.NOT_FOUND);
    return this.testCredInput({
      apiKey: got.cred.apiKey,
      clientId: got.cred.clientId,
      笔记类型: got.sourceType,
    });
  }

  // ── 同步：startSync + getSyncStatus（与 mail-archive 同范式） ────────

  /**
   * 异步启动「立即收取」：HTTP 立即返回，同步在后台执行，进度写入 syncStates 供轮询。
   * 同一个配置已在同步中时直接返回现有状态，不重复启动（避免并发把同一批笔记拉两遍）。
   */
  startSync(recordId: string): SourceSyncProgress {
    const running = this.syncStates.get(recordId);
    if (running?.running) return running;
    const state: SourceSyncProgress = {
      running: true,
      startedAt: Date.now(),
      fetched: 0,
      stored: 0,
      created: 0,
      sourceName: '',
    };
    this.syncStates.set(recordId, state);
    void this.runSync(recordId, state); // 不 await：后台跑
    return state;
  }

  /** 查询某配置当前/最近一次同步进度 */
  getSyncStatus(recordId: string): SourceSyncProgress {
    return this.syncStates.get(recordId) ?? {
      running: false, startedAt: 0, fetched: 0, stored: 0, created: 0, sourceName: '',
    };
  }

  /** 后台执行同步并把结果回填到进度对象 + 飞书记录 */
  private async runSync(recordId: string, state: SourceSyncProgress): Promise<void> {
    try {
      const r = await this.syncOne(recordId);
      state.fetched = r.fetched;
      state.stored = r.stored;
      state.created = r.created;
      state.sourceName = r.sourceName;
      state.error = r.error;
      state.result = r.resultText;
      await this.writeBack(recordId, {
        '上次同步时间': new Date().getTime(),
        '上次同步结果': r.resultText.slice(0, 500),
      });
    } catch (e) {
      const msg = (e as Error).message;
      state.error = msg;
      await this.writeBack(recordId, {
        '上次同步时间': new Date().getTime(),
        '上次同步结果': `失败：${msg}`.slice(0, 500),
      }).catch((err) => this.logger.error(`回写同步结果失败 ${recordId}: ${(err as Error).message}`));
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  }

  /** 回写飞书记录，失败仅记日志（避免主流程被吞） */
  private async writeBack(recordId: string, fields: Record<string, unknown>) {
    try {
      await this.base.update(this.meta.tableId, recordId, fields);
    } catch (e) {
      this.logger.warn(`回写知识库配置失败 ${recordId}: ${(e as Error).message}`);
    }
  }

  /**
   * 同步单个配置：拿到凭证 → 拉笔记 → 把「新增笔记 ID」缓存到本服务内存。
   *
   * 当前只支持「得到大脑」：循环调用 /open/api/v1/resource/note/list，
   * 直到 cursor 拿空。每次循环统计「拉到的 / 真正新增的」条数，
   * 最后把结果写回飞书「上次同步时间 / 上次同步结果」字段。
   *
   * ⚠️ 为什么**不**写 noteLink 表：
   * 笔记正文权威数据在 openapi.biji.com，本服务不落库、不双写（与 getnote.service
   * 同原则）。noteLink 表是"业务实体 ↔ 笔记"的关联映射，跟"自动同步"是两个维度。
   * 自动同步的笔记直接由「我的笔记页」通过 Get笔记 列表接口按来源名筛。
   *
   * ⚠️ 增量策略：
   * 上游没有 note_id-only 增量接口，所以每次走"全量翻页 + 用 processNote() 内存去重"。
   * processNote 是注入点：默认实现只统计条数；如需"立即同步进我的笔记缓存"可在这里扩展。
   * 各配置「收取频率」字段决定扫描节奏（外部 cron 每 15 分钟驱动 syncAllDue）。
   */
  private async syncOne(recordId: string): Promise<{
      fetched: number;
      stored: number;
      created: number;
      sourceName: string;
      error?: string;
      resultText: string;
    }> {
    const got = await this.getCredForSync(recordId);
    if (!got) return { fetched: 0, stored: 0, created: 0, sourceName: '', error: '配置不存在', resultText: '失败：配置不存在' };
    const rec = await this.base.get(this.meta.tableId, recordId);
    const fields = rec?.fields ?? {};
    const sourceName = plainText(fields['配置名称']);
    const sourceType = got.sourceType;

    if (sourceType !== '得到大脑') {
      return {
        fetched: 0, stored: 0, created: 0, sourceName,
        resultText: `${sourceName}（${sourceType}）：暂未接入，仅「得到大脑」支持立即收取`,
      };
    }
    const { apiKey, clientId } = got.cred;
    if (!apiKey || !clientId) {
      return { fetched: 0, stored: 0, created: 0, sourceName, error: '凭证缺失', resultText: '失败：凭证缺失 apiKey 或 clientId' };
    }

    let cursor = '';
    let fetched = 0;
    let processed = 0;
    const errors: string[] = [];
    const cred = { key: apiKey, clientId };
    // 预加载该配置已映射的 noteId：本次只给**新笔记**补归属，稳态下零写入
    const mapped = await this.loadMappedNoteIds(recordId);
    const mapCounter = { created: 0 };

    do {
      const r = await this.getnote.listWithCred(cred, cursor, undefined, 50);
      fetched += r.notes.length;
      for (const note of r.notes) {
        const noteId = String(note.note_id ?? note.id ?? '').trim();
        if (!noteId) continue;
        try {
          // 注入点：把这条新笔记「处理」一遍（写入 笔记 ↔ 配置 归属）。
          // 归属跟随配置行 —— 配置是谁的，它同步来的笔记就是谁的。
          await this.processNote({
            note,
            sourceName,
            sourceType,
            configId: recordId,
            ownerName: plainText(fields['归属人']),
            ownerOpenId: plainText(fields['归属人ID']),
            mapped,
            counter: mapCounter,
          });
          processed++;
        } catch (e) {
          errors.push(`noteId=${noteId}: ${(e as Error).message.slice(0, 80)}`);
        }
      }
      cursor = String(r.cursor ?? '');
      if (!r.has_more) break;
    } while (cursor && processed < 5000); // 单次最多处理 5000 条，防止失控

    const resultText = errors.length
      ? `处理 ${processed}/${fetched} 条；失败 ${errors.length}（${errors[0] ?? ''}）`
      : `处理 ${processed} 条，本次共拉取 ${fetched} 条`;
    return { fetched, stored: processed, created: processed, sourceName, resultText };
  }

  /**
   * 同步开始前把该配置**已映射**的 noteId 全量拉进内存。
   *
   * ⚠️ 为什么必须预加载：飞书没有批量写入，逐条 create 已经够慢了；
   * 若每条笔记再查一次「是否已映射」，请求数直接翻倍（N 次读 + N 次写）。
   * 预加载后**只有新笔记才写**，稳态下几乎零写入。
   */
  private async loadMappedNoteIds(configId: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      let pageToken: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await this.base.search(TABLES.noteConfigMap.tableId, {
          pageSize: 200,
          pageToken,
          filter: buildFilter([{ field: '配置ID', value: [configId] }]),
        });
        for (const r of res.items) {
          const id = plainText((r.fields as Record<string, unknown>)['笔记ID']);
          if (id) out.add(id);
        }
        if (!res.hasMore || !res.pageToken) break;
        pageToken = res.pageToken;
      }
    } catch (e) {
      // 预加载失败不阻断同步：退化成"全部当新笔记"，靠 CONFIG_MAP_MAX_CREATE 兜底
      this.logger.warn(`预加载笔记配置映射失败 ${configId}: ${(e as Error).message}`);
    }
    return out;
  }

  /**
   * 单条笔记处理钩子：把「这篇笔记属于哪个配置」写进「笔记配置映射」表。
   *
   * 为什么需要：Get笔记 的 note 对象里**没有任何字段**能标识归属 —— 实测 source
   * 恒为 "app"（平台自己的来源标识，指手机 App 录音）、note_type 是录音类型、
   * tags 里也没有配置名。而列表要展示「配置名称」列，归属只能由 ACMS 侧记录。
   *
   * ⚠️ 写入失败只记日志、不往上抛：归属是"锦上添花"的元数据，
   * 不该把整次同步拖垮（笔记本身已经在 Get笔记 那儿，不依赖这张表）。
   */
  private async processNote(opts: {
    note: { note_id?: string; id?: string; title?: string };
    sourceName: string;
    sourceType: string;
    configId: string;
    ownerName: string;
    ownerOpenId: string;
    mapped: Set<string>;
    counter: { created: number };
  }): Promise<void> {
    const noteId = String(opts.note?.note_id ?? opts.note?.id ?? '').trim();
    if (!noteId || opts.mapped.has(noteId)) return; // 已映射：稳态下绝大多数走这条
    if (opts.counter.created >= CONFIG_MAP_MAX_CREATE) return; // 单批封顶，防限流

    const now = Date.now();
    try {
      await this.base.create(TABLES.noteConfigMap.tableId, {
        笔记ID: noteId,
        笔记标题: String(opts.note?.title ?? '').slice(0, 200),
        配置ID: opts.configId,
        配置名称: opts.sourceName,
        笔记类型: opts.sourceType,
        归属人: opts.ownerName,
        归属人ID: opts.ownerOpenId,
        首次同步时间: now,
        更新时间: now,
      });
      opts.mapped.add(noteId); // 同批次内不会再重复写
      opts.counter.created += 1;
    } catch (e) {
      this.logger.warn(`写笔记配置映射失败 noteId=${noteId}: ${(e as Error).message}`);
    }
  }

  /**
   * 调度入口：被 cron 每 15 分钟触发一次，遍历「启用 + 收取频率到期」的配置。
   * 走法与 mail-archive.syncAll 完全一致：扫描所有启用的配置，按各配置自己的频率节流。
   */
  async syncAllDue(): Promise<{ synced: number; skipped: number; results: Record<string, unknown> }> {
    const res = await this.base.search(this.meta.tableId, {
      pageSize: 100,
      filter: buildFilter([{ field: '启用状态', value: ['启用'] }]),
    });
    const results: Record<string, unknown> = {};
    let synced = 0;
    let skipped = 0;
    for (const row of res.items) {
      const id = row.recordId;
      const fields = row.fields as Record<string, unknown>;
      const lastRaw = fields['上次同步时间'];
      const last = typeof lastRaw === 'number' ? lastRaw : 0;
      // 把 cron 反解成分钟数（仅 4 档；不在表里的兜底 60 分钟）
      const intervalMs = cronToMinutes(freqToCron(fields['收取频率'])) * 60 * 1000;
      if (last && Date.now() - last < intervalMs) {
        skipped++;
        continue;
      }
      this.startSync(id);
      synced++;
      results[String(fields['配置名称'] ?? id)] = 'scheduled';
    }
    return { synced, skipped, results };
  }

  /** 暴露给 module 用的「调度注册表」：返回一个 map，让 module 在 onModuleInit 里遍历注册 */
  listEnabledCronJobs(): Array<{ recordId: string; sourceName: string; cron: string }> {
    // 不实际拉数据（onModuleInit 启动时还未连飞书），由模块构造后通过 syncAllDue() 驱动
    return [];
  }

  /** 给 module 用的：列出所有启用的配置 + 其 cron 表达式（用于调度重建） */
  async listEnabledForScheduler(): Promise<Array<{ recordId: string; sourceName: string; cron: string }>> {
    const res = await this.base.search(this.meta.tableId, {
      pageSize: 100,
      filter: buildFilter([{ field: '启用状态', value: ['启用'] }]),
    });
    return res.items.map((r) => {
      const f = r.fields as Record<string, unknown>;
      return {
        recordId: r.recordId,
        sourceName: plainText(f['配置名称']),
        cron: freqToCron(f['收取频率']),
      };
    });
  }
}

/** cron 表达式 → 估算分钟数（仅支持本模块的 4 档）。反解失败兜底 60 分钟 */
function cronToMinutes(cron: string): number {
  if (cron === '*/15 * * * *') return 15;
  if (cron === '*/30 * * * *') return 30;
  if (cron === '0 * * * *') return 60;
  if (cron === '0 3 * * *') return 1440;
  return 60;
}
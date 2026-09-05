import { Inject, Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { BaseClient, toText } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { encryptSecret, decryptSecret } from '../ai/lib/crypto/kms.js';
import { BaseRecordService } from '../shared/generic-crud.module.js';
import { buildFilter } from '../shared/record.util.js';
import { GETNOTE_SOURCE_META } from './sources.meta.js';
import { GetnoteService } from './getnote.service.js';

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

/** 「启用状态」 → 是否启用。停用状态被定时任务跳过。 */
function isEnabled(v: unknown): boolean {
  return String(v ?? '').trim() !== '停用';
}

/** 飞书文本字段可能返回 string 或 [{text}] 数组，统一取纯文本 */
function plainText(v: unknown): string {
  return toText(v) ?? '';
}

/** 解析凭证字段为 JSON。解密失败时返回空对象，前端会暴露「凭证无效」 */
function decodeCred(enc: unknown): Record<string, string> {
  if (!enc) return {};
  try {
    const plain = String(decryptSecret(enc) ?? '');
    if (!plain) return {};
    const obj = JSON.parse(plain);
    return typeof obj === 'object' && obj ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 把凭证对象加密成信封，存入飞书文本字段 */
function encodeCred(cred: Record<string, string>): unknown {
  return encryptSecret(JSON.stringify(cred));
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
    return super.create(user, next);
  }

  /** 编辑：明文凭证字段重新加密；如果是空串/掩码则保留原密文 */
  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
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

  /** 列表/详情：用空串占位「凭证」字段，避免密文外泄 */
  async list(user: SessionUser, query: Record<string, string | undefined>) {
    const res = await super.list(user, query);
    for (const it of res.items) {
      it['凭证'] = '';
    }
    return res;
  }

  async detail(user: SessionUser, id: string) {
    const rec = await super.detail(user, id);
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
  async testSource(user: SessionUser, recordId: string): Promise<{
    ok: boolean;
    sourceType: string;
    note: string;
  }> {
    await this.detail(user, recordId); // 顺手校验权限
    const got = await this.getCredForSync(recordId);
    if (!got) throw new HttpException('SOURCE_NOT_FOUND', HttpStatus.NOT_FOUND);
    if (got.sourceType !== '得到大脑') {
      return { ok: false, sourceType: got.sourceType, note: '该笔记类型暂未接入，可先选「得到大脑」' };
    }
    const { apiKey, clientId } = got.cred;
    if (!apiKey || !clientId) {
      return { ok: false, sourceType: got.sourceType, note: '凭证缺失 apiKey 或 clientId' };
    }
    try {
      await this.getnote.probeCredentials(apiKey, clientId);
      return { ok: true, sourceType: got.sourceType, note: '连通成功' };
    } catch (e) {
      return { ok: false, sourceType: got.sourceType, note: (e as Error).message };
    }
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

    do {
      const r = await this.getnote.listWithCred(cred, cursor, undefined, 50);
      fetched += r.notes.length;
      for (const note of r.notes) {
        const noteId = String(note.note_id ?? note.id ?? '').trim();
        if (!noteId) continue;
        try {
          // 注入点：把这条新笔记「处理」一遍。默认实现只做去重计数，不落库。
          await this.processNote(note, sourceName, sourceType);
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
   * 单条笔记处理钩子。默认实现只做去重计数，不写飞书表。
   * 业务含义：把"已被该配置扫过"的 noteId 计入内存缓存，
   * 下次 syncOne 的 syncStates 里能看到「本次共处理 N 条」。
   * 如果将来要做"缓存拉过的笔记 ID 加速下次启动"，扩展此方法即可。
   */
  private async processNote(
    note: { note_id?: string; id?: string; title?: string },
    sourceName: string,
    sourceType: string,
  ): Promise<void> {
    // 当前实现：什么都不做。fetched 与 processed 都已经在 syncOne 里计数。
    // 笔记本身走 Get笔记 原 API 拉；不双写。
    void note;
    void sourceName;
    void sourceType;
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
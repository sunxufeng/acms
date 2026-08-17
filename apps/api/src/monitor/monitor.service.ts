import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { readFileSync } from 'node:fs';

/**
 * M7 监控探针（进程内，无需外部依赖）：
 *  - 启动 + 每 5 分钟：检查内存(P1 高位) 与 飞书凭证/存储可达性(P0)
 *  - 异常时通过飞书 OpenAPI（应用身份 tenant_access_token 调 im/v1/messages）直发告警
 *    到通知目标（默认 BOOTSTRAP_ADMIN_OPEN_IDS[0]，可用 FEISHU_NOTIFY_TARGET 覆盖），带 30 分钟冷却
 *  - 暴露 getStatus() 供 /api/v1/monitor/status 查询最近一次探测快照
 *  - notify() 对外提供「立即发送」能力（无冷却），供业务侧主动推送状态
 */
export interface MonitorSnapshot {
  time: string;
  kind: 'boot' | 'tick';
  heapMb: number;
  rssMb: number;
  feishuOk: boolean;
  notes: string[];
}

@Injectable()
export class MonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Monitor');
  private timer?: NodeJS.Timeout;
  private lastAlertAt = 0;
  private last: MonitorSnapshot = {
    time: new Date(0).toISOString(),
    kind: 'boot',
    heapMb: 0,
    rssMb: 0,
    feishuOk: true,
    notes: [],
  };
  private readonly intervalMs = 5 * 60 * 1000;
  private readonly memP1Mb = Number(process.env.MONITOR_MEM_P1_MB ?? 1500);
  private envCache: Record<string, string> | null = null;

  private tenantToken?: string;
  private tokenExp = 0;

  onModuleInit(): void {
    void this.run('boot').then(() => {
      void this.notify('ACMS API 已启动，飞书通知通道已接入（OpenAPI 直发）。');
    });
    this.timer = setInterval(() => void this.run('tick'), this.intervalMs);
    // 不阻塞进程退出
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getStatus(): MonitorSnapshot {
    return this.last;
  }

  /** 读取环境变量（优先 process.env，缺失时兜底读取 /opt/acms/.env） */
  private env(key: string): string | undefined {
    if (process.env[key] !== undefined) return process.env[key];
    if (!this.envCache) {
      this.envCache = {};
      try {
        for (const line of readFileSync('/opt/acms/.env', 'utf8').split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) this.envCache[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
      } catch {
        /* ignore */
      }
    }
    return this.envCache[key];
  }

  /** 取 tenant_access_token（带缓存，提前 60s 过期刷新） */
  private async getToken(): Promise<string | null> {
    const now = Date.now();
    if (this.tenantToken && now < this.tokenExp) return this.tenantToken;
    const id = this.env('FEISHU_APP_ID');
    const secret = this.env('FEISHU_APP_SECRET');
    if (!id || !secret) return null;
    try {
      const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: id, app_secret: secret }),
      });
      const j = (await r.json()) as { code?: number; tenant_access_token?: string; expire?: number };
      if (j.code !== 0 || !j.tenant_access_token) return null;
      this.tenantToken = j.tenant_access_token;
      this.tokenExp = now + (j.expire ?? 7200) * 1000 - 60_000;
      return this.tenantToken;
    } catch {
      return null;
    }
  }

  /** 解析通知目标：FEISHU_NOTIFY_TARGET 优先，否则取 BOOTSTRAP_ADMIN_OPEN_IDS 首个。oc_ 前缀视为群 chat_id */
  private resolveTarget(): { id: string; type: 'open_id' | 'chat_id' } | null {
    const raw = (this.env('FEISHU_NOTIFY_TARGET') || (this.env('BOOTSTRAP_ADMIN_OPEN_IDS') || '').split(',')[0] || '').trim();
    if (!raw) return null;
    return { id: raw, type: raw.startsWith('oc_') ? 'chat_id' : 'open_id' };
  }

  /** 经飞书 OpenAPI 发送文本消息；返回是否成功 */
  private async sendMessage(text: string): Promise<boolean> {
    const token = await this.getToken();
    if (!token) {
      this.logger.warn('[监控] 无飞书凭证，跳过发送');
      return false;
    }
    const t = this.resolveTarget();
    if (!t) {
      this.logger.warn('[监控] 未配置通知目标，跳过发送');
      return false;
    }
    try {
      const r = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${t.type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ receive_id: t.id, msg_type: 'text', content: JSON.stringify({ text }) }),
      });
      const j = (await r.json()) as { code?: number; msg?: string };
      if (j.code === 0) return true;
      this.logger.error(`[监控] 飞书发送失败 code=${j.code} msg=${j.msg}`);
      return false;
    } catch (e) {
      this.logger.error('[监控] 飞书发送异常: ' + (e as Error).message);
      return false;
    }
  }

  /** 对外：立即发送（无冷却）。供状态推送使用，返回是否成功 */
  async notify(text: string): Promise<boolean> {
    return this.sendMessage(`[ACMS] ${text}`);
  }

  private async run(kind: 'boot' | 'tick'): Promise<void> {
    const notes: string[] = [];
    const mem = process.memoryUsage();
    const heapMb = mem.heapUsed / 1024 / 1024;
    const rssMb = mem.rss / 1024 / 1024;

    let feishuOk = true;
    try {
      feishuOk = (await this.getToken()) !== null;
      if (!feishuOk) notes.push('飞书 tenant_access_token 获取失败');
    } catch (e) {
      feishuOk = false;
      notes.push('飞书探测异常: ' + (e as Error).message);
    }

    this.last = {
      time: new Date().toISOString(),
      kind,
      heapMb: Math.round(heapMb),
      rssMb: Math.round(rssMb),
      feishuOk,
      notes,
    };

    const alerts: string[] = [];
    if (heapMb > this.memP1Mb) {
      alerts.push(`P1 内存高位 heapUsed=${Math.round(heapMb)}MB > ${this.memP1Mb}MB`);
    }
    if (!feishuOk) {
      alerts.push('P0 飞书凭证/存储不可达');
    }
    if (alerts.length) await this.alert(alerts.join('；'));
  }

  private async alert(text: string): Promise<void> {
    if (!this.resolveTarget()) {
      this.logger.warn('[监控] 未配置通知目标，仅本地记录: ' + text);
      return;
    }
    const now = Date.now();
    if (now - this.lastAlertAt < 30 * 60 * 1000) {
      this.logger.warn('[监控] 告警冷却中(30min): ' + text);
      return;
    }
    this.lastAlertAt = now;
    const ok = await this.sendMessage(`[ACMS 监控告警] ${text} @ ${new Date().toLocaleString('zh-CN')}`);
    if (ok) this.logger.warn('[监控] 已发送飞书告警: ' + text);
  }
}

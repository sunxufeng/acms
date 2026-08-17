import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { readFileSync } from 'node:fs';

/**
 * M7 监控探针（进程内，无需外部依赖）：
 *  - 启动 + 每 5 分钟：检查内存(P1 高位) 与 飞书凭证/存储可达性(P0)
 *  - 异常时向 FEISHU_NOTIFY_TARGET 飞书机器人推送告警（带 30 分钟冷却），未配置则仅本地日志
 *  - 暴露 getStatus() 供 /api/v1/monitor/status 查询最近一次探测快照
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

  onModuleInit(): void {
    void this.run('boot');
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

  private async run(kind: 'boot' | 'tick'): Promise<void> {
    const notes: string[] = [];
    const mem = process.memoryUsage();
    const heapMb = mem.heapUsed / 1024 / 1024;
    const rssMb = mem.rss / 1024 / 1024;

    let feishuOk = true;
    try {
      feishuOk = await this.checkFeishu();
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

  private async checkFeishu(): Promise<boolean> {
    const id = this.env('FEISHU_APP_ID');
    const secret = this.env('FEISHU_APP_SECRET');
    if (!id || !secret) return true; // 无凭证（本地开发）跳过
    const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: id, app_secret: secret }),
    });
    const j = (await r.json()) as { code?: number };
    return j.code === 0;
  }

  private async alert(text: string): Promise<void> {
    const target = this.env('FEISHU_NOTIFY_TARGET');
    if (!target) {
      this.logger.warn('[监控] 未配置 FEISHU_NOTIFY_TARGET，仅本地记录: ' + text);
      return;
    }
    const now = Date.now();
    if (now - this.lastAlertAt < 30 * 60 * 1000) {
      this.logger.warn('[监控] 告警冷却中(30min): ' + text);
      return;
    }
    this.lastAlertAt = now;
    try {
      const ts = String(Math.floor(now / 1000));
      const body: Record<string, unknown> = {
        msg_type: 'text',
        content: { text: `[ACMS 监控告警] ${text} @ ${new Date().toLocaleString('zh-CN')}` },
      };
      const secret = this.env('FEISHU_NOTIFY_SECRET');
      if (secret) {
        const { createHmac } = await import('node:crypto');
        const sign = createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
        body.timestamp = ts;
        body.sign = sign;
      }
      await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.logger.warn('[监控] 已发送飞书告警: ' + text);
    } catch (e) {
      this.logger.error('[监控] 飞书告警发送失败: ' + (e as Error).message);
    }
  }
}

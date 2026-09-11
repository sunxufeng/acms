import { Inject, Injectable } from '@nestjs/common';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type Redis from 'ioredis';
import { REDIS } from '../redis.provider.js';

const execFileAsync = promisify(execFile);

/** 单条命令超时：页面要秒开，任何一条卡住都不该拖垮整个接口 */
const CMD_TIMEOUT = 3000;
/** 生产部署根目录（部署脚本与备份脚本都在这个路径下） */
const ACMS_ROOT = '/opt/acms';
const BACKUP_DIR = `${ACMS_ROOT}/data/pg_backup`;

interface CmdResult {
  ok: boolean;
  out: string;
}

/**
 * 执行白名单里的只读命令。
 *
 * ⚠️ 安全约定：
 *  - 命令与参数全部由本文件写死，**绝不拼接任何外部输入**（用户传参一律不进命令）；
 *  - 唯一动态的部分是 systemd unit 里的 slot 端口，必须由 /^\d{4}$/ 校验通过才可用；
 *  - 失败只返回 ok:false，不抛异常，页面降级显示「不可用」。
 */
async function runCmd(file: string, args: string[]): Promise<CmdResult> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: CMD_TIMEOUT });
    return { ok: true, out: String(stdout ?? '').trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

function safeSlot(raw: string): string | null {
  return /^\d{4}$/.test(raw.trim()) ? raw.trim() : null;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

@Injectable()
export class SystemMonitorService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** 主机：CPU / 负载 / 内存 / 磁盘 / 运行时长 */
  private async host() {
    const cpus = os.cpus();
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    // df -B1 <挂载点>：第 2 行是「总 已用 可用 使用率 挂载点」
    const df = await runCmd('df', ['-B1', '/']);
    let disk: { total: number; used: number; available: number } | null = null;
    if (df.ok) {
      const cells = df.out.split('\n')[1]?.trim().split(/\s+/) ?? [];
      const total = Number(cells[1]);
      const used = Number(cells[2]);
      const available = Number(cells[3]);
      if (total > 0) disk = { total, used, available };
    }
    const load = os.loadavg();
    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpuModel: cpus[0]?.model ?? '未知',
      cpuCores: cpus.length,
      load1: Number(load[0]?.toFixed(2) ?? 0),
      load5: Number(load[1]?.toFixed(2) ?? 0),
      load15: Number(load[2]?.toFixed(2) ?? 0),
      memTotal,
      memUsed: memTotal - memFree,
      memTotalText: fmtBytes(memTotal),
      memUsedText: fmtBytes(memTotal - memFree),
      memUsagePercent: memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 100) : 0,
      disk: disk
        ? {
            total: disk.total,
            used: disk.used,
            available: disk.available,
            totalText: fmtBytes(disk.total),
            usedText: fmtBytes(disk.used),
            availableText: fmtBytes(disk.available),
            usagePercent: Math.round((disk.used / disk.total) * 100),
          }
        : null,
      uptimeSeconds: Math.round(os.uptime()),
      uptimeText: fmtDuration(os.uptime()),
    };
  }

  /** 应用进程：PID / 运行时长 / 内存 / Node 版本 / 当前 slot 与构建号 */
  private async app() {
    const slotRaw = await readFile(`${ACMS_ROOT}/.deploy_slot`, 'utf8').catch(() => '');
    const slot = safeSlot(slotRaw) ?? null;
    let buildId: string | null = null;
    if (slot) {
      // Web 端口 = API 端口 + 100（Blue-Green 双实例的固定规则）
      const webSlot = String(Number(slot) + 100);
      buildId = await readFile(`${ACMS_ROOT}/repo/apps/web/.next-${webSlot}/BUILD_ID`, 'utf8')
        .then((s) => s.trim())
        .catch(() => null);
    }
    const mem = process.memoryUsage();
    return {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      uptimeText: fmtDuration(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      rss: mem.rss,
      rssText: fmtBytes(mem.rss),
      heapUsed: mem.heapUsed,
      heapUsedText: fmtBytes(mem.heapUsed),
      slot,
      buildId,
    };
  }

  /** 依赖：PostgreSQL（走 psql，零新增依赖）与 Redis（复用现有 ioredis） */
  private async deps() {
    // 固定 SQL，不接受任何外部输入
    const sql =
      "select pg_database_size(current_database()) || '|' || " +
      "(select count(*) from information_schema.tables where table_schema = current_schema()) || '|' || " +
      "(select count(*) from pg_stat_activity where datname = current_database())";
    const url = process.env.DATABASE_URL ?? '';
    const pg = url
      ? await runCmd('psql', [url, '-tAc', sql])
      : { ok: false, out: '' };
    let postgres: Record<string, unknown> | null = null;
    if (pg.ok && pg.out.includes('|')) {
      const [size, tables, conns] = pg.out.split('|');
      postgres = {
        ok: true,
        dbSizeText: fmtBytes(Number(size) || 0),
        tableCount: Number(tables) || 0,
        connections: Number(conns) || 0,
      };
    } else {
      postgres = { ok: false };
    }

    let redis: Record<string, unknown>;
    try {
      const keys = await this.redis.dbsize();
      const info = await this.redis.info('memory');
      const used = Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0);
      redis = { ok: true, keys, memoryText: fmtBytes(used) };
    } catch {
      redis = { ok: false };
    }

    return { postgres, redis };
  }

  /** 服务状态：只读 systemctl is-active，unit 白名单 */
  private async services(slot: string | null) {
    const units = [
      { name: 'API', unit: slot ? `acms-api@${slot}` : null },
      { name: 'Web', unit: slot ? `acms-web@${Number(slot) + 100}` : null },
      { name: 'Nginx', unit: 'nginx' },
      { name: 'PostgreSQL', unit: 'postgresql' },
      { name: 'Redis', unit: 'redis' },
    ];
    return Promise.all(
      units.map(async (u) => {
        if (!u.unit) return { name: u.name, unit: '—', active: 'unknown' as const };
        const r = await runCmd('systemctl', ['is-active', u.unit]);
        return {
          name: u.name,
          unit: u.unit,
          active: r.ok ? (r.out === 'active' ? ('active' as const) : ('inactive' as const)) : ('unknown' as const),
          detail: r.ok && r.out !== 'active' ? r.out : undefined,
        };
      }),
    );
  }

  /** 备份：最近 5 个 SQL 转储文件（pg_backup.sh 每天一个 .sql.gz） */
  private async backups() {
    try {
      const files = await readdir(BACKUP_DIR);
      const dumps = files.filter((f) => f.endsWith('.sql.gz')).sort().reverse().slice(0, 5);
      const items = await Promise.all(
        dumps.map(async (f) => {
          const s = await stat(path.join(BACKUP_DIR, f)).catch(() => null);
          return {
            name: f,
            sizeText: s ? fmtBytes(s.size) : '—',
            at: s ? s.mtime.toISOString() : null,
          };
        }),
      );
      return { ok: true as const, dir: BACKUP_DIR, items };
    } catch {
      return { ok: false as const, dir: BACKUP_DIR, items: [] };
    }
  }

  /** 近期错误：API 单元最近 20 条 error 及以上级别日志 */
  private async errors(slot: string | null) {
    if (!slot) return { ok: false as const, unit: null, lines: [] as string[] };
    const unit = `acms-api@${slot}`;
    const r = await runCmd('journalctl', ['-u', unit, '-p', 'err', '-n', '20', '--no-pager', '-o', 'short-iso']);
    if (!r.ok) return { ok: false as const, unit, lines: [] as string[] };
    const lines = r.out.split('\n').filter(Boolean).slice(-20);
    return { ok: true as const, unit, lines };
  }

  async status() {
    const slotRaw = await readFile(`${ACMS_ROOT}/.deploy_slot`, 'utf8').catch(() => '');
    const slot = safeSlot(slotRaw) ?? null;
    const [hostRes, appRes, depsRes, servicesRes, backupsRes, errorsRes] = await Promise.allSettled([
      this.host(),
      this.app(),
      this.deps(),
      this.services(slot),
      this.backups(),
      this.errors(slot),
    ]);
    const pick = <T>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === 'fulfilled' ? r.value : fallback);
    return {
      collectedAt: new Date().toISOString(),
      host: pick(hostRes, null),
      app: pick(appRes, null),
      deps: pick(depsRes, null),
      services: pick(servicesRes, []),
      backups: pick(backupsRes, { ok: false as const, dir: BACKUP_DIR, items: [] }),
      errors: pick(errorsRes, { ok: false as const, unit: null, lines: [] as string[] }),
    };
  }
}

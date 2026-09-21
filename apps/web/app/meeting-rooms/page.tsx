'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  MEETING_DAY_END_HOUR,
  MEETING_DAY_START_HOUR,
  MEETING_BUCKET_MS,
  bucketize,
  dayWindow,
  hhmm,
  nowProgress,
  shiftDateKey,
  todayKey,
  type BusySpan,
  type FindFreeResult,
  type MeetingRoomInfo,
  type RoomAvailability,
  type RoomAvailabilityItem,
} from '@acms/contracts';
import { api, type MeetingRoomLocalResult } from '../../lib/api';
import { usePermissions } from '../../lib/permissions';

/**
 * 会议室助手（组织管理）。
 *
 * 界面口径（对照业务方给的参考图）：
 *   - 左侧：每行一个会议室 = 名称 / 楼栋·人数 / 设备标签 + 08:00–22:00 的小时轴（14 格）
 *   - 右侧：「找空闲助手」= 人数 + 起止时段 + 楼栋 → 命中的会议室
 *   - 数据来源写在页脚：房间与层级来自飞书同步，占用是实时的（带抓取时间）
 *
 * 🔴 两条「不许糊弄」的显示规则：
 *   ① 占用读不到（飞书没权限/接口挂了）⇒ **整体灰显 + 写明原因**，绝不画成一片空闲 ——
 *      「读不到」和「今天没人用」长得一模一样，会有人照着绿格去开会。
 *   ② 数据抓取时间必须回显（「数据截至 14:32」），否则用户以为看到的是此刻的真实状态。
 */

/** 容量筛选项（不限 / 常见档位）；`0` = 不限 */
const CAPACITY_CHOICES = [0, 4, 6, 8, 10, 12, 20, 30, 50, 100];
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 日期键 → 「2026-09-21 周一」 */
function dateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return `${dateKey} ${WEEKDAYS[dt.getDay()]}`;
}

function fmtClock(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export default function MeetingRoomsPage() {
  const t = useTranslations('meetingRooms');
  const perms = usePermissions();
  /** 同步是写动作：没有权限就不渲染按钮（点了必然 403） */
  const canSync = perms.includes('module:meetingRooms:update');

  const [date, setDate] = useState(() => todayKey());
  const [levelName, setLevelName] = useState('');
  const [capacity, setCapacity] = useState(0);

  const [local, setLocal] = useState<MeetingRoomLocalResult | null>(null);
  const [avail, setAvail] = useState<RoomAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncErr, setSyncErr] = useState('');

  const [fCap, setFCap] = useState('12');
  const [fFrom, setFFrom] = useState('14:00');
  const [fTo, setFTo] = useState('16:00');
  const [findBusy, setFindBusy] = useState(false);
  const [findRes, setFindRes] = useState<FindFreeResult | null>(null);
  const [findErr, setFindErr] = useState('');

  /** 「现在」竖线的时间基准（每 30s 走一格即可，不必每秒渲染） */
  const [, setTick] = useState(0);

  const loadLocal = useCallback(async () => {
    try {
      const r = await api.listMeetingRooms();
      setLocal(r);
    } catch (e) {
      setErr((e as Error).message || String(e));
    }
  }, []);

  const loadAvail = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.meetingRoomAvailability({
        date,
        levelId: '',
        minCapacity: 0,
      });
      setAvail(r);
      setErr('');
    } catch (e) {
      setAvail(null);
      setErr((e as Error).message || String(e));
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  useEffect(() => {
    void loadAvail();
  }, [loadAvail]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const win = useMemo(() => dayWindow(date), [date]);
  const isToday = date === todayKey();
  const nowP = nowProgress(win.startMs, win.endMs);

  /** 楼栋候选：从房间里取（只显示真实存在的楼栋，避免空楼栋占位） */
  const levelNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of local?.rooms ?? []) if (r.levelName) set.add(r.levelName);
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [local]);

  /** 当前展示的房间：本地房间按楼栋/容量过滤后，与可用度的占用配对 */
  const rows = useMemo(() => {
    const busyOf = new Map<string, BusySpan[]>();
    for (const r of avail?.rooms ?? []) busyOf.set(r.roomId, r.busy ?? []);
    const list: RoomAvailabilityItem[] = (local?.rooms ?? [])
      .filter((r) => (levelName ? r.levelName === levelName : true))
      .filter((r) => (capacity ? r.capacity >= capacity : true))
      .map((r: MeetingRoomInfo) => ({ ...r, busy: busyOf.get(r.roomId) ?? [] }));
    // 排序：楼栋 → 容量 → 名称（跨楼栋时按楼栋聚在一起更好读）
    return list.sort(
      (a, b) =>
        a.levelName.localeCompare(b.levelName, 'zh-CN') ||
        (a.capacity || 0) - (b.capacity || 0) ||
        a.name.localeCompare(b.name, 'zh-CN'),
    );
  }, [local, avail, levelName, capacity]);

  const matchIds = useMemo(
    () => new Set((findRes?.matches ?? []).map((r) => r.roomId)),
    [findRes],
  );

  /** 占用数据不可信时的整体灰显标记 */
  const degraded = avail?.degraded ?? '';

  async function doSync() {
    setSyncing(true);
    setSyncErr('');
    setSyncMsg('');
    try {
      const r = await api.syncMeetingRooms();
      if (!r.ok) {
        setSyncErr(r.error ?? t('syncFailed'));
        if (r.denied && r.authUrl) setSyncMsg(r.authUrl);
      } else {
        setSyncMsg(t('syncOk', { levels: r.levels ?? 0, rooms: r.rooms ?? 0 }));
        await loadLocal();
        await loadAvail();
      }
    } catch (e) {
      setSyncErr((e as Error).message || String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function doFind() {
    setFindBusy(true);
    setFindErr('');
    setFindRes(null);
    try {
      const r = await api.findFreeMeetingRooms({
        date,
        from: fFrom,
        to: fTo,
        minCapacity: Number(fCap) || 0,
        levelId: '',
      });
      setFindRes(r);
    } catch (e) {
      setFindErr((e as Error).message || String(e));
    } finally {
      setFindBusy(false);
    }
  }

  const authLink = syncMsg.startsWith('https://') ? syncMsg : '';

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
          <div className="page-header-actions">
            {avail?.fetchedAt ? (
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
                {t('dataAsOf', { time: fmtClock(avail.fetchedAt) })}
              </span>
            ) : null}
            <button className="btn btn-outline btn-sm" onClick={() => void loadAvail()} disabled={loading}>
              {t('refresh')}
            </button>
            {canSync ? (
              <button className="btn btn-primary btn-sm" onClick={() => void doSync()} disabled={syncing}>
                {syncing ? t('syncing') : t('sync')}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {syncErr ? (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          <div className="notice-title">{t('syncFailed')}</div>
          <div className="notice-detail">{syncErr}</div>
          {authLink ? (
            <div className="notice-detail">
              <a href={authLink} target="_blank" rel="noreferrer">
                {t('openAuth')}
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
      {syncMsg && !authLink ? (
        <div className="notice notice-ok" style={{ marginBottom: 16 }}>
          <div className="notice-detail">{syncMsg}</div>
        </div>
      ) : null}

      {degraded ? (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          <div className="notice-title">{t('degradedTitle')}</div>
          <div className="notice-detail">{degraded}</div>
          {degraded.includes('权限') && local?.authUrl ? (
            <div className="notice-detail">
              <a href={local.authUrl} target="_blank" rel="noreferrer">
                {t('openAuth')}
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      {err ? (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          <div className="notice-detail">{err}</div>
        </div>
      ) : null}

      <div className="filter-bar" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setDate(shiftDateKey(date, -1))}>
            ‹
          </button>
          <span style={{ fontWeight: 600, minWidth: 148, textAlign: 'center' }}>{dateLabel(date)}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setDate(shiftDateKey(date, 1))}>
            ›
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => setDate(todayKey())}>
            {t('today')}
          </button>
        </div>

        <span
          className={levelName ? 'chip' : 'chip chip-active'}
          onClick={() => setLevelName('')}
          role="button"
        >
          {t('buildingAll')}
        </span>
        {levelNames.map((n) => (
          <span
            key={n}
            className={levelName === n ? 'chip chip-active' : 'chip'}
            onClick={() => setLevelName(levelName === n ? '' : n)}
            role="button"
          >
            {n}
          </span>
        ))}

        <select
          className="form-input"
          style={{ width: 132, marginLeft: 'auto' }}
          value={capacity}
          onChange={(e) => setCapacity(Number(e.target.value))}
        >
          {CAPACITY_CHOICES.map((c) => (
            <option key={c} value={c}>
              {c ? t('capacityAtLeast', { n: c }) : t('capacityAll')}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── 左侧：可用度时间轴 ───────────────────────────────── */}
        <div className="card" style={{ flex: '1 1 420px', minWidth: 320, padding: 16 }}>
          {rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-text">
                {loading ? t('loading') : avail?.degraded ? t('degradedEmpty') : t('emptyTitle')}
              </div>
              <div className="empty-state-text" style={{ color: 'var(--fg-tertiary)', marginTop: 8 }}>
                {!loading && !avail?.degraded ? t('emptyHint') : ''}
              </div>
            </div>
          ) : (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '150px 1fr',
                  gap: 10,
                  fontSize: 'var(--font-xs)',
                  color: 'var(--fg-tertiary)',
                  marginBottom: 6,
                }}
              >
                <div />
                <div style={{ position: 'relative', height: 14 }}>
                  <span style={{ position: 'absolute', left: 0 }}>{pad2(MEETING_DAY_START_HOUR)}:00</span>
                  <span style={{ position: 'absolute', left: '28.5%' }}>
                    {pad2(MEETING_DAY_START_HOUR + 4)}:00
                  </span>
                  <span style={{ position: 'absolute', left: '57%' }}>
                    {pad2(MEETING_DAY_START_HOUR + 8)}:00
                  </span>
                  <span style={{ position: 'absolute', left: '85.7%' }}>
                    {pad2(MEETING_DAY_START_HOUR + 12)}:00
                  </span>
                  <span style={{ position: 'absolute', right: 0 }}>{pad2(MEETING_DAY_END_HOUR)}:00</span>
                </div>
              </div>

              {rows.map((room) => (
                <RoomRow
                  key={room.roomId}
                  room={room}
                  win={win}
                  isHit={matchIds.has(room.roomId)}
                  showNow={isToday && nowP !== null}
                  nowP={nowP ?? 0}
                  greyed={Boolean(degraded)}
                />
              ))}

              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  marginTop: 14,
                  fontSize: 'var(--font-xs)',
                  color: 'var(--fg-secondary)',
                }}
              >
                <Legend color="var(--success-muted)" border="transparent" label={t('legendFree')} />
                <Legend color="var(--danger-muted)" border="var(--danger)" label={t('legendBusy')} />
                <Legend color="transparent" border="var(--accent)" label={t('legendMatch')} />
              </div>
            </>
          )}
        </div>

        {/* ── 右侧：找空闲助手 ─────────────────────────────────── */}
        <div className="card" style={{ flex: '0 0 264px', padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--font-md)' }}>{t('findTitle')}</div>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', marginTop: 6, lineHeight: 1.6 }}>
            {t('findHint')}
          </div>

          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', margin: '12px 0 4px' }}>
            {t('findCapacity')}
          </div>
          <input
            className="form-input"
            type="number"
            min={1}
            value={fCap}
            onChange={(e) => setFCap(e.target.value)}
            style={{ width: '100%' }}
          />

          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', margin: '12px 0 4px' }}>
            {t('findTime')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-input"
              type="time"
              value={fFrom}
              onChange={(e) => setFFrom(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <input
              className="form-input"
              type="time"
              value={fTo}
              onChange={(e) => setFTo(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 16 }}
            onClick={() => void doFind()}
            disabled={findBusy}
          >
            {findBusy ? t('finding') : t('findBtn')}
          </button>

          {findErr ? (
            <div className="notice notice-error" style={{ marginTop: 12 }}>
              <div className="notice-detail">{findErr}</div>
            </div>
          ) : null}

          {findRes ? (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {findRes.degraded ? (
                <div className="notice notice-error">
                  <div className="notice-detail">{findRes.degraded}</div>
                </div>
              ) : findRes.matches.length === 0 ? (
                <div className="notice notice-info">
                  <div className="notice-detail">
                    {findRes.candidates === 0
                      ? t('findNoRoom')
                      : t('findAllBusy', { n: findRes.candidates })}
                  </div>
                </div>
              ) : (
                findRes.matches.map((m) => (
                  <div
                    key={m.roomId}
                    style={{
                      border: '1px solid var(--accent)',
                      background: 'var(--accent-muted)',
                      borderRadius: 'var(--radius-md)',
                      padding: '10px 12px',
                      fontSize: 'var(--font-xs)',
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>
                      {m.name}
                      {m.levelName ? ` · ${m.levelName}` : ''}
                      {m.capacity ? ` · ${m.capacity}${t('people')}` : ''}
                    </div>
                    <div style={{ marginTop: 4, color: 'var(--fg-secondary)' }}>
                      {t('findHit', { from: fFrom, to: fTo })}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>

      <p style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 16, lineHeight: 1.7 }}>
        {t('footerNote', { from: MEETING_DAY_START_HOUR, to: MEETING_DAY_END_HOUR, bucket: MEETING_BUCKET_MS / 3600000 })}
      </p>
    </div>
  );
}

/** 图例小方块 */
function Legend({ color, border, label }: { color: string; border: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: 3,
          background: color,
          border: `2px solid ${border}`,
        }}
      />
      {label}
    </span>
  );
}

/**
 * 一个会议室行：名称 / 楼栋·人数 / 设备 + 小时轴。
 *
 * ⚠️ 占用与空闲**用 title 说明**（悬停可见具体时段）——不显示会议主题：
 *    峰哥 2026-09-21 定的口径是「只显示已占用」，不把别人的会议标题亮给全公司。
 */
function RoomRow({
  room,
  win,
  isHit,
  showNow,
  nowP,
  greyed,
}: {
  room: RoomAvailabilityItem;
  win: { startMs: number; endMs: number };
  isHit: boolean;
  showNow: boolean;
  nowP: number;
  greyed: boolean;
}) {
  const cells = bucketize(room.busy, win.startMs, win.endMs);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '150px 1fr',
        gap: 10,
        alignItems: 'center',
        padding: '8px 0',
        borderBottom: '1px solid var(--border)',
        opacity: greyed ? 0.55 : room.disabled ? 0.6 : 1,
        outline: isHit ? '2px solid var(--accent)' : 'none',
        outlineOffset: 2,
        borderRadius: isHit ? 'var(--radius-md)' : 0,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 'var(--font-sm)', display: 'flex', gap: 6 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {room.name}
          </span>
          {room.disabled ? (
            <span className="badge" style={{ flexShrink: 0 }}>
              {/* 维护中的房间不参与「找空闲」，但列表里保留并标出来 */}
              {'维护中'}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-secondary)', marginTop: 2 }}>
          {[room.levelName, room.floor, room.capacity ? `${room.capacity}人` : '']
            .filter(Boolean)
            .join(' · ')}
        </div>
        {room.devices.length ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {room.devices.map((d) => (
              <span key={d} className="badge">
                {d}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ position: 'relative', display: 'flex', gap: 2 }}>
        {cells.map((occ, i) => {
          const s = win.startMs + i * MEETING_BUCKET_MS;
          const e = Math.min(s + MEETING_BUCKET_MS, win.endMs);
          return (
            <span
              key={i}
              title={`${hhmm(s)}–${hhmm(e)}`}
              style={{
                flex: 1,
                height: 22,
                borderRadius: 3,
                background: occ ? 'var(--danger-muted)' : 'var(--success-muted)',
                border: `1px solid ${occ ? 'var(--danger)' : 'transparent'}`,
              }}
            />
          );
        })}
        {showNow ? (
          <span
            style={{
              position: 'absolute',
              top: -3,
              bottom: -3,
              width: 2,
              background: 'var(--warning)',
              left: `${Math.min(Math.max(nowP, 0), 1) * 100}%`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

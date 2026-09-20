'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api, type BehaviourStatsResult } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { usePermissions } from '../../lib/permissions';
import FollowUpModal from '../../components/behaviour/FollowUpModal';
import {
  DateField,
  DateTimeField,
  Notice,
  StatCard,
  Tabs,
  alertLevelClass,
  fmtDate,
  fmtDateTime,
  statusClassOf,
  truncate,
} from '../../components/behaviour/fields';

/**
 * 行为记录（Behaviour）—— 对齐 GibbonEdu/core v31 的行为/奖惩模块。
 *
 *   行为记录  一个学生一条，多学生同一次事件用「批次号」关联
 *   跟进流水  对某条行为的后续处理（谈话/电话/家访/书面/其它）
 *   学生告警  **由行为记录重算出来的派生结果**（不是手填），可删可重建
 *   通知信件  按告警等级生成家长通知（正文由服务端模板 + 行为事实生成）
 *   统计      按班级/年级汇总行为条数与告警数
 *
 * 与其他模块的差异（刻意的）：
 *   · 告警不由人新增 —— 列表 `hideCreate`，只在行为记录写入/删除后自动重算，
 *     也可以在行上手动「重算告警」补一次。
 *   · 信件不由人新增 —— 在告警行上点「生成通知信件」，同告警同一档只生成一次。
 *   · 「学生姓名 / 班级」是服务端从学生档案补齐的冗余列，表单里只选学生。
 *
 * ⚠️ 「重算告警」的可选学生参数走 `studentId`（后端 deepFilter），
 *    而不是 `学生__has`：告警列表按学生过滤时后者不生效（告警的「学生」是 link 字段，
 *    且该参数在告警 meta 里登记为 deepParams）。用专用接口语义更明确。
 */

const YES_NO = ['是', '否'];
const RECORD_STATUSES = ['草稿', '已发布', '已归档'];
const ALERT_LEVELS = ['轻度', '中度', '严重'];
const ALERT_STATUSES = ['未处理', '处理中', '已解除'];
const LETTER_TYPES = ['提醒', '警告', '严重警告'];
const LETTER_STATUSES = ['草稿', '已发送', '已确认'];

const RECORD_TRANSITIONS: Record<string, string[]> = {
  草稿: ['已发布', '已归档'],
  已发布: ['已归档', '草稿'],
  已归档: ['草稿'],
};
const ALERT_TRANSITIONS: Record<string, string[]> = {
  未处理: ['处理中', '已解除'],
  处理中: ['已解除', '未处理'],
  已解除: ['未处理'],
};
const LETTER_TRANSITIONS: Record<string, string[]> = {
  草稿: ['已发送'],
  已发送: ['已确认', '草稿'],
  已确认: ['已发送'],
};

interface LinkOption {
  value: string;
  label: string;
}

/** link 字段候选项：只取第一页（pageSize 上限 500），单校学生量级够用 */
function toOptions(rows: Record<string, unknown>[], nameKey: string): LinkOption[] {
  return rows
    .map((r) => ({ value: String(r.id ?? ''), label: String(r[nameKey] ?? '') }))
    .filter((x) => x.value && x.label);
}

/** 行上的关联字段原始 id（列表行由后端 resolveLinks 注入 `<字段>__link` 数组） */
function rowLinkId(row: Record<string, unknown>, field: string): string {
  const arr = row[`${field}__link`];
  if (Array.isArray(arr) && arr.length) return String(arr[0]);
  return '';
}

type TabKey = 'records' | 'alerts' | 'letters' | 'stats';

export default function BehaviourPage() {
  const tl = useTl();
  const perms = usePermissions();
  const canUpdate = perms.includes('module:behaviour:update');
  const canCreate = perms.includes('module:behaviour:create');

  const [tab, setTab] = useState<TabKey>('records');
  const [editing, setEditing] = useState(false);
  const [students, setStudents] = useState<LinkOption[]>([]);
  const [followUpRow, setFollowUpRow] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState<{ kind: 'info' | 'ok' | 'error'; title: string; detail?: string } | null>(null);
  const [stats, setStats] = useState<BehaviourStatsResult | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listStudents({ pageSize: '500' })
      .then((r) => {
        if (alive) setStudents(toOptions(r.items ?? [], '学生姓名'));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const reloadStats = useCallback(async () => {
    try {
      const r = await api.getBehaviourStats();
      setStats(r);
      setStatsErr(null);
    } catch (e) {
      setStats(null);
      setStatsErr((e as Error).message);
    }
  }, []);

  // ── 全量重算（记录页与告警页共用一个动作）──────────────────────────
  const recalcAll = useCallback(
    async (reload?: () => void) => {
      setMsg({ kind: 'info', title: tl('正在重算告警…') });
      try {
        const r = await api.recalcBehaviourAlerts({});
        setMsg({
          kind: 'ok',
          title: tl('告警重算完成'),
          detail: `${tl('新增')} ${r.新增} · ${tl('更新')} ${r.更新} · ${tl('解除')} ${r.解除} · ${tl('未变')} ${r.未变} · ${tl(
            '扫描学生数',
          )} ${r.扫描学生数}（${r.告警窗口.join(' / ')}）`,
        });
      } catch (e) {
        setMsg({ kind: 'error', title: tl('告警重算失败'), detail: (e as Error).message });
      }
      reload?.();
      if (tab === 'stats') void reloadStats();
    },
    [tl, tab, reloadStats],
  );

  // ── 行为记录 ──────────────────────────────────────────────────────
  const recordColumns = useMemo<CrudColumn[]>(
    () => [
      {
        key: '学生', label: '学生', width: '150px',
        form: true, required: true, type: 'link', linkOptions: students,
        filter: true, filterParam: '学生__has', filterOptions: students.map((x) => x.label),
        section: '行为信息',
        hint: '选学生后，列表用的「学生姓名 / 班级」由服务端自动补齐',
      },
      // 读字典「行为类型」（正向 / 负向）。这两个值参与告警累计口径（负向才计告警），
      // 所以字典里这两个 key 的文案不要改（改了会让历史与新记录分成两拨）。
      { key: '行为类型', label: '行为类型', width: '90px', form: true, required: true, type: 'select', dictKey: '行为类型', filter: true, section: '行为信息' },
      { key: '行为分类', label: '行为分类', width: '110px', form: true, type: 'text', section: '行为信息', hint: '如 课堂纪律 / 作业提交 / 文明礼貌；自由文本，同一口径写同一种叫法' },
      { key: '分值', label: '分值', width: '70px', form: true, type: 'number', section: '行为信息', hint: '负向行为填负数或正数都可以，告警按**绝对值**累计；正向行为不计入告警' },
      {
        key: '发生日期', label: '发生日期', width: '110px',
        form: true, renderField: ({ value, onChange }) => <DateField value={value} onChange={onChange} />,
        render: (v) => <span className="muted">{fmtDate(v)}</span>,
        section: '行为信息',
      },
      {
        key: '发生时间', label: '发生时间', width: '140px',
        form: true, list: false, renderField: ({ value, onChange }) => <DateTimeField value={value} onChange={onChange} />,
        section: '行为信息',
        hint: '精确到分钟；只填「发生日期」也能统计，两者都填时以「发生时间」为准',
      },
      { key: '描述', label: '描述', width: '260px', form: true, type: 'textarea', fieldHeight: 90, section: '行为信息', hint: '客观描述发生了什么，家长信件的明细直接取这段文字' },
      { key: '地点', label: '地点', width: '110px', form: true, type: 'text', section: '行为信息' },
      { key: '班级', label: '班级', width: '110px', form: true, type: 'text', section: '行为信息', hint: '留空时自动取学生的「当前班级」' },
      { key: '记录人', label: '记录人', width: '100px', form: true, type: 'text', section: '行为信息' },
      { key: '批次号', label: '批次号', width: '120px', form: true, type: 'text', section: '行为信息', hint: '多学生同一次事件（如一起打闹）填同一个批次号，便于回溯整件事' },
      { key: '学生可见', label: '学生可见', width: '90px', form: true, type: 'select', options: YES_NO, filter: true, filterOptions: YES_NO, section: '可见性与状态' },
      { key: '家长可见', label: '家长可见', width: '90px', form: true, type: 'select', options: YES_NO, filter: true, filterOptions: YES_NO, section: '可见性与状态', hint: '与「学生可见」是两个独立开关，可只对一方可见' },
      { key: '状态', label: '状态', width: '90px', filter: true, filterOptions: RECORD_STATUSES, section: '可见性与状态' },
      { key: '学生姓名', label: '学生姓名', width: '110px', listOrder: 2, render: (v) => <span>{String(v ?? '—')}</span> },
      { key: '更新时间', label: '更新时间', width: '150px', listOrder: 99, render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
    ],
    [students],
  );

  const recordRowActions = useMemo(
    () => [
      {
        // ⚠️ CrudPage 对 rowExtraActions.label **不做** tl() 翻译（只有 extraActions 会），
        //    所以这里自己译好再传，否则英文界面下会露出中文
        label: tl('跟进'),
        run: (row: Record<string, unknown>) => setFollowUpRow(row),
      },
      ...(canUpdate
        ? [
            {
              label: tl('重算告警'),
              run: async (row: Record<string, unknown>) => {
                const sid = rowLinkId(row, '学生');
                if (!sid) {
                  setMsg({ kind: 'error', title: tl('该记录未关联学生，无法重算告警') });
                  return;
                }
                setMsg({ kind: 'info', title: tl('正在重算告警…') });
                try {
                  const r = await api.recalcBehaviourAlerts({ studentId: sid });
                  setMsg({
                    kind: 'ok',
                    title: tl('告警重算完成'),
                    detail: `${String(row['学生姓名'] ?? '')}：${tl('新增')} ${r.新增} · ${tl('更新')} ${r.更新} · ${tl('解除')} ${r.解除}`,
                  });
                } catch (e) {
                  setMsg({ kind: 'error', title: tl('告警重算失败'), detail: (e as Error).message });
                }
              },
            },
          ]
        : []),
    ],
    [canUpdate, tl],
  );

  // ── 告警 ──────────────────────────────────────────────────────────
  const alertColumns = useMemo<CrudColumn[]>(
    () => [
      { key: '学生姓名', label: '学生姓名', width: '110px' },
      {
        key: '告警等级', label: '告警等级', width: '90px',
        filter: true, filterOptions: ALERT_LEVELS,
        render: (v) => {
          const s = String(v ?? '');
          return s ? <span className={`status-dot ${alertLevelClass(s)}`}>{tl(s)}</span> : <span className="muted">—</span>;
        },
      },
      { key: '告警窗口', label: '告警窗口', width: '200px' },
      {
        key: '触发原因', label: '触发原因', width: '300px',
        render: (v) => <span title={String(v ?? '')}>{truncate(v, 34)}</span>,
      },
      { key: '关联行为条数', label: '关联行为条数', width: '110px' },
      { key: '关联分值合计', label: '关联分值合计', width: '120px' },
      { key: '班级', label: '班级', width: '110px' },
      {
        key: '状态', label: '状态', width: '90px',
        filter: true, filterOptions: ALERT_STATUSES,
        form: true, type: 'select', options: ALERT_STATUSES, section: '处理情况',
      },
      { key: '处理人', label: '处理人', width: '110px', form: true, type: 'text', section: '处理情况' },
      {
        key: '处理说明', label: '处理说明', width: '240px',
        form: true, type: 'textarea', fieldHeight: 90, list: false, section: '处理情况',
        hint: '记录了处理动作与结果，重算告警不会覆盖这里',
      },
      {
        key: '是否已通知家长', label: '是否已通知家长', width: '130px',
        form: true, type: 'select', options: YES_NO, filter: true, filterOptions: YES_NO, section: '处理情况',
      },
      { key: '首次触发时间', label: '首次触发时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
      { key: '最近触发时间', label: '最近触发时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
    ],
    [tl],
  );

  const alertRowActions = useMemo(
    () =>
      canCreate
        ? [
            {
              label: tl('生成通知信件'),
              run: async (row: Record<string, unknown>) => {
                const alertId = String(row.id ?? '');
                if (!alertId) return;
                if (!String(row['告警等级'] ?? '')) {
                  setMsg({ kind: 'error', title: tl('该告警已解除，无法生成家长通知') });
                  return;
                }
                setMsg({ kind: 'info', title: tl('正在生成信件…') });
                try {
                  const r = await api.generateBehaviourLetter({
                    alertId,
                    studentId: rowLinkId(row, '学生') || undefined,
                  });
                  setMsg({
                    kind: r.created ? 'ok' : 'info',
                    title: r.created ? tl('信件已生成') : tl('该告警同一档已生成过信件'),
                    // ⚠️ tl() 不支持插值（useTl 直接按 key 查表），所以数字与文案分开拼，
                    //    不要写成 tl('第{ n }次') 这种——那样会原样显示 key
                    detail: `${String(row['学生姓名'] ?? '')} · ${tl(r.信件类型)}${
                      r.第几次 ? ` · ${r.第几次} ${tl('次')}` : ''
                    }`,
                  });
                } catch (e) {
                  setMsg({ kind: 'error', title: tl('生成信件失败'), detail: (e as Error).message });
                }
              },
            },
          ]
        : [],
    [canCreate, tl],
  );

  // ── 通知信件 ──────────────────────────────────────────────────────
  const letterColumns = useMemo<CrudColumn[]>(
    () => [
      { key: '学生姓名', label: '学生姓名', width: '110px' },
      {
        key: '信件类型', label: '信件类型', width: '100px',
        form: false, filter: true, filterOptions: LETTER_TYPES,
        render: (v) => <span>{tl(String(v ?? '—'))}</span>,
      },
      {
        key: '创建时计数', label: '创建时计数', width: '110px',
        listOrder: 3, render: (v) => <span>{`${Number(v ?? 0) || 0} ${tl('次')}`}</span>,
      },
      { key: '收件家长', label: '收件家长', width: '150px', form: true, type: 'text', section: '发送情况', hint: '默认「学生姓名 家长」，可直接改成具体称呼' },
      {
        key: '状态', label: '状态', width: '90px',
        form: true, type: 'select', options: LETTER_STATUSES, filter: true, filterOptions: LETTER_STATUSES,
        section: '发送情况',
      },
      {
        key: '发送时间', label: '发送时间', width: '150px',
        form: true, renderField: ({ value, onChange }) => <DateTimeField value={value} onChange={onChange} />,
        render: (v) => <span className="muted">{fmtDateTime(v)}</span>,
        section: '发送情况',
        hint: '系统不会真的发信；人工发完后把状态改为「已发送」并填上时间',
      },
      { key: '生成时间', label: '生成时间', width: '150px', render: (v) => <span className="muted">{fmtDateTime(v)}</span> },
      {
        key: '信件正文', label: '信件正文', width: '260px',
        form: true, type: 'textarea', fieldHeight: 260, list: false, readonly: true,
        hint: '由服务端按模板 + 行为事实生成，不可手工修改',
      },
      {
        key: '正文预览', label: '正文预览', width: '280px', listOrder: 8, form: false,
        render: (_v, row) => <span title={String(row['信件正文'] ?? '')}>{truncate(row['信件正文'], 40)}</span>,
      },
    ],
    [tl],
  );

  const summary = stats?.汇总;

  return (
    <>
      {!editing && (
        <Tabs<TabKey>
          value={tab}
          onChange={(k) => {
            setTab(k);
            setMsg(null);
            if (k === 'stats') void reloadStats();
          }}
          tabs={[
            { key: 'records', label: tl('行为记录') },
            { key: 'alerts', label: tl('告警') },
            { key: 'letters', label: tl('通知信件') },
            { key: 'stats', label: tl('统计') },
          ]}
        />
      )}

      {!editing && msg ? (
        <Notice kind={msg.kind} title={msg.title}>
          {msg.detail}
        </Notice>
      ) : null}

      {tab === 'records' && (
        <CrudPage
          title="行为记录"
          subtitle="一个学生一条记录；多学生同一次事件用「批次号」关联。告警由这些记录自动重算得出，不需要手填"
          moduleKey="behaviour"
          columns={recordColumns}
          statusField="状态"
          transitions={RECORD_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          onEditingChange={setEditing}
          search={{ placeholder: '搜索学生姓名 / 描述 / 行为分类 / 地点 / 批次号' }}
          rangeFilters={[{ key: '发生日期', label: '发生日期', fromParam: '发生日期_from', toParam: '发生日期_to' }]}
          rowExtraActions={recordRowActions}
          // ⚠️ extraActions 的 label 由 CrudPage 内部 tl() 翻译 → 必须传**中文原文**
          extraActions={canUpdate ? [{ label: '重算全部告警', run: (reload) => void recalcAll(reload) }] : undefined}
          api={{
            list: (p) => api.behaviourRecords.list(p),
            create: (d) => api.behaviourRecords.create(d),
            update: (id, d) => api.behaviourRecords.update(id, d),
            archive: (id) => api.behaviourRecords.archive(id),
            transition: (id, to) => api.behaviourRecords.transition(id, to),
          }}
        />
      )}

      {tab === 'alerts' && (
        <CrudPage
          title="学生告警"
          subtitle="由行为记录重算得出的派生结果：负向分值累计达标或负向条数达标即产生；累计与条数都低于轻度阈值时自动「解除」（保留历史）"
          moduleKey="behaviour"
          columns={alertColumns}
          statusField="状态"
          transitions={ALERT_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          hideCreate
          onEditingChange={setEditing}
          search={{ placeholder: '搜索学生姓名 / 班级 / 触发原因' }}
          rowExtraActions={alertRowActions}
          extraActions={canUpdate ? [{ label: '重算全部告警', run: (reload) => void recalcAll(reload) }] : undefined}
          api={{
            list: (p) => api.behaviourAlerts.list(p),
            update: (id, d) => api.behaviourAlerts.update(id, d),
            archive: (id) => api.behaviourAlerts.archive(id),
            transition: (id, to) => api.behaviourAlerts.transition(id, to),
          }}
        />
      )}

      {tab === 'letters' && (
        <CrudPage
          title="通知信件"
          subtitle="按告警等级生成（提醒 / 警告 / 严重警告），正文由服务端按模板与行为事实生成；系统不代发，发送状态人工维护"
          moduleKey="behaviour"
          columns={letterColumns}
          statusField="状态"
          transitions={LETTER_TRANSITIONS}
          statusClass={statusClassOf}
          inlineEdit
          standaloneForm
          hideCreate
          onEditingChange={setEditing}
          search={{ placeholder: '搜索学生姓名 / 收件家长 / 信件正文' }}
          api={{
            list: (p) => api.behaviourLetters.list(p),
            update: (id, d) => api.behaviourLetters.update(id, d),
            archive: (id) => api.behaviourLetters.archive(id),
            transition: (id, to) => api.behaviourLetters.transition(id, to),
          }}
        />
      )}

      {tab === 'stats' && !editing && (
        <div className="page">
          <div className="page-header page-header-row">
            <div>
              <div className="page-eyebrow">BEHAVIOUR / STATS</div>
              <h1 className="page-title">{tl('行为统计')}</h1>
              <p className="page-subtitle">
                {tl('按班级与年级汇总行为条数与告警数；告警口径：负向分值累计 ≥ 5/10/20 分或负向行为 ≥ 3 条，取满足的最高档。')}
              </p>
            </div>
            <div className="page-actions">
              <button className="btn btn-outline" onClick={() => void reloadStats()}>
                {tl('刷新')}
              </button>
            </div>
          </div>

          {statsErr ? (
            <Notice kind="error" title={tl('统计读取失败')}>
              {statsErr}
            </Notice>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 'var(--space-md)',
              marginBottom: 'var(--space-xl)',
            }}
          >
            <StatCard label={tl('行为条数')} value={summary?.行为条数 ?? 0} />
            <StatCard label={tl('正向条数')} value={summary?.正向条数 ?? 0} />
            <StatCard label={tl('负向条数')} value={summary?.负向条数 ?? 0} />
            <StatCard label={tl('涉及学生数')} value={summary?.涉及学生数 ?? 0} />
            <StatCard label={tl('未解除告警数')} value={summary?.告警数 ?? 0} sub={`${tl('涉及学生')} ${summary?.告警人数 ?? 0}`} />
            <StatCard label={tl('轻度')} value={summary?.轻度 ?? 0} />
            <StatCard label={tl('中度')} value={summary?.中度 ?? 0} />
            <StatCard label={tl('严重')} value={summary?.严重 ?? 0} />
          </div>

          {!stats?.items.length && !statsErr ? (
            <div className="empty-state">
              <div className="empty-state-text">{tl('还没有行为记录：先到「行为记录」里录一条，统计才有数据。')}</div>
            </div>
          ) : (
            <>
              <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 700, marginBottom: 'var(--space-md)' }}>{tl('按班级')}</h2>
              <div className="data-table-wrap" style={{ marginBottom: 'var(--space-xl)' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{tl('班级')}</th>
                      <th>{tl('行为条数')}</th>
                      <th>{tl('正向条数')}</th>
                      <th>{tl('负向条数')}</th>
                      <th>{tl('涉及学生数')}</th>
                      <th>{tl('未解除告警数')}</th>
                      <th>{tl('轻度')}</th>
                      <th>{tl('中度')}</th>
                      <th>{tl('严重')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats?.items.map((r) => (
                      <tr key={r.班级}>
                        <td>{r.班级}</td>
                        <td>{r.行为条数}</td>
                        <td>{r.正向条数}</td>
                        <td>{r.负向条数}</td>
                        <td>{r.涉及学生数}</td>
                        <td>{r.告警数}</td>
                        <td>{r.轻度}</td>
                        <td>{r.中度}</td>
                        <td>{r.严重}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 700, marginBottom: 'var(--space-md)' }}>{tl('按年级')}</h2>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{tl('年级')}</th>
                      <th>{tl('行为条数')}</th>
                      <th>{tl('正向条数')}</th>
                      <th>{tl('负向条数')}</th>
                      <th>{tl('涉及学生数')}</th>
                      <th>{tl('未解除告警数')}</th>
                      <th>{tl('轻度')}</th>
                      <th>{tl('中度')}</th>
                      <th>{tl('严重')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats?.byGrade.map((r) => (
                      <tr key={r.年级}>
                        <td>{r.年级}</td>
                        <td>{r.行为条数}</td>
                        <td>{r.正向条数}</td>
                        <td>{r.负向条数}</td>
                        <td>{r.涉及学生数}</td>
                        <td>{r.告警数}</td>
                        <td>{r.轻度}</td>
                        <td>{r.中度}</td>
                        <td>{r.严重}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {followUpRow ? (
        <FollowUpModal
          record={followUpRow}
          canWrite={canCreate}
          onClose={() => setFollowUpRow(null)}
          onSaved={() => setMsg({ kind: 'ok', title: tl('跟进已保存') })}
        />
      ) : null}
    </>
  );
}

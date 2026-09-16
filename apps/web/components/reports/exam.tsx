'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ExamDistReport, type ExamGpaReport } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { BarRow, EmptyData, MetricCard, MetricRow, Panel, SimpleTable } from './charts';

/**
 * 考试与成绩的两张报表（2026-09-16 Phase 2）。
 *
 * 与别的报表一致的三件事：
 *  1. 口径的真源在后端（`reports/exam-stats.ts` 的纯函数 + `examDistribution()` 的取数），
 *     页面只负责呈现；页脚必须有「口径说明」，否则用户会把它当成系统结论。
 *  2. 数据源是**期末总评快照**（不是成绩册的原始条目）—— 报表要跟成绩单对得上。
 *  3. **按当前用户的学生数据范围过滤**（后端做），页面把范围注记显示出来：
 *     班主任看到的 25 人和管理员看到的 82 人必然不同，不写清楚就会被当成 bug。
 */

/** 下钻到期末总评明细（该页支持从 URL 初始化筛选，见 exam-grades/page.tsx） */
function useDrill() {
  const router = useRouter();
  return (params: Record<string, string>) => {
    const q = new URLSearchParams({ tab: 'term', ...params });
    router.push(`/exam-grades?${q.toString()}`);
  };
}

const fmtNum = (v: number | null | undefined, digits = 1): string =>
  v == null ? '—' : v.toFixed(digits);

const fmtPct = (v: number | null | undefined): string => (v == null ? '—' : `${v}%`);

// ══════════════════════════════════════════════════════════════════
// ① 考试成绩分布
// ══════════════════════════════════════════════════════════════════

export function ExamDistPanel() {
  const tl = useTl();
  const drill = useDrill();
  const [batchId, setBatchId] = useState('');
  const [cls, setCls] = useState('');
  const [subject, setSubject] = useState('');
  const [data, setData] = useState<ExamDistReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.reportExamDist({ batchId, cls, subject }));
    } catch (e) {
      setError((e as Error).message || tl('加载失败'));
    } finally {
      setLoading(false);
    }
  }, [batchId, cls, subject, tl]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <div className="muted" style={{ padding: 20 }}>{tl('加载中…')}</div>;
  if (error) return <div className="notice notice-error">{error}</div>;
  if (!data) return null;
  if (data.reason) {
    return <EmptyData title={tl('暂时没有可统计的成绩')} hint={data.reason} />;
  }

  const s = data.summary;
  const bandMax = Math.max(1, ...data.bands.map((b) => b.count));
  const levelMax = Math.max(1, ...data.byLevel.map((b) => b.count));

  return (
    <>
      <Panel
        title={tl('筛选')}
        extra={
          <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
            {tl('数据源：期末总评快照')} · {data.scopeNote ?? ''}
          </span>
        }
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select className="form-input" style={{ width: 260 }} value={data.batchId} onChange={(e) => { setBatchId(e.target.value); }}>
            {(data.batches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.status ? `（${b.status}）` : ''}
              </option>
            ))}
          </select>
          <select className="form-input" style={{ width: 150 }} value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">{tl('全部班级')}</option>
            {data.classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className="form-input" style={{ width: 150 }} value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">{tl('全部科目')}</option>
            {data.subjects.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </Panel>

      <MetricRow>
        <MetricCard label={tl('学生数')} value={s.students} sub={`${s.records} ${tl('条总评记录')}`} />
        <MetricCard label={tl('平均分')} value={fmtNum(s.avg)} />
        <MetricCard label={tl('中位数')} value={fmtNum(s.median)} />
        <MetricCard label={tl('及格率')} value={fmtPct(s.passRate)} sub={tl('≥ 60 分')} />
        <MetricCard label={tl('达标率')} value={fmtPct(s.attainedRate)} sub={tl('按等级序号判定')} />
        <MetricCard label={tl('最高 / 最低')} value={`${fmtNum(s.max)} / ${fmtNum(s.min)}`} />
      </MetricRow>

      <Panel title={tl('分数段分布')}>
        {data.bands.map((b) => (
          <BarRow key={b.label} label={tl(b.label)} value={b.count} max={bandMax} />
        ))}
      </Panel>

      {data.byLevel.length > 0 && (
        <Panel title={tl('等级分布')}>
          {data.byLevel.map((b) => (
            <BarRow key={b.level} label={b.level} value={b.count} max={levelMax} />
          ))}
        </Panel>
      )}

      <Panel title={tl('按科目')} extra={<span className="muted" style={{ fontSize: 'var(--font-xs)' }}>{tl('点科目可跳到期末总评明细')}</span>}>
        <SimpleTable
          head={[tl('科目'), tl('记录数'), tl('平均分'), tl('达标率')]}
          rows={data.bySubject.map((r) => [r.subject, r.count, fmtNum(r.avg), fmtPct(r.attainedRate)])}
          clickableCols={[0]}
          onCellClick={(i) => {
            const row = data.bySubject[i];
            if (row) drill({ batchId: data.batchId, cls, subject: row.subject });
          }}
        />
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Panel title={tl('前 10 名')}>
          <SimpleTable
            head={[tl('学生'), tl('班级'), tl('科目'), tl('总评'), tl('等级')]}
            rows={data.top.map((r) => [r.studentName, r.cls, r.subject, fmtNum(r.total), r.level || '—'])}
          />
        </Panel>
        <Panel title={tl('后 10 名')}>
          <SimpleTable
            head={[tl('学生'), tl('班级'), tl('科目'), tl('总评'), tl('等级')]}
            rows={data.bottom.map((r) => [r.studentName, r.cls, r.subject, fmtNum(r.total), r.level || '—'])}
          />
        </Panel>
      </div>

      <Panel title={tl('口径说明')}>
        <div className="muted" style={{ fontSize: 'var(--font-xs)', lineHeight: 1.9 }}>
          · {tl('数据源是「期末总评」的结转快照，不是成绩册的原始条目 —— 与成绩单口径一致。')}
          <br />· {tl('平均分 / 中位数 / 及格率按「总评」逐条计算（一个学生一个科目算一条）。')}
          <br />· {tl('及格线固定为 60 分；达标率按等级的序号判定（序号越小越好），未设目标的记录不计入达标率分子。')}
          <br />· {tl('数据范围：')}{data.scopeNote ?? ''}
          <br />· {tl('还没有结转过的班级不会出现在这里 —— 先去「考试与成绩」里点一键结转。')}
        </div>
      </Panel>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════
// ② GPA 与班级排名
// ══════════════════════════════════════════════════════════════════

export function ExamGpaPanel() {
  const tl = useTl();
  const [batchId, setBatchId] = useState('');
  const [cls, setCls] = useState('');
  const [data, setData] = useState<ExamGpaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyTop, setOnlyTop] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.reportExamGpa({ batchId, cls }));
    } catch (e) {
      setError((e as Error).message || tl('加载失败'));
    } finally {
      setLoading(false);
    }
  }, [batchId, cls, tl]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <div className="muted" style={{ padding: 20 }}>{tl('加载中…')}</div>;
  if (error) return <div className="notice notice-error">{error}</div>;
  if (!data) return null;
  if (data.reason) {
    return <EmptyData title={tl('暂时没有可统计的成绩')} hint={data.reason} />;
  }

  const rows = onlyTop ? data.rows.slice(0, 20) : data.rows;
  const distMax = Math.max(1, ...data.distribution.map((b) => b.count));

  return (
    <>
      <Panel
        title={tl('筛选')}
        extra={
          <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
            {data.scopeNote ?? ''}
          </span>
        }
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-input" style={{ width: 260 }} value={data.batchId} onChange={(e) => setBatchId(e.target.value)}>
            {(data.batches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.status ? `（${b.status}）` : ''}
              </option>
            ))}
          </select>
          <select className="form-input" style={{ width: 150 }} value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">{tl('全部班级')}</option>
            {data.classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </Panel>

      {!data.gpaConfigured && (
        <div className="notice notice-warn">
          <span>⚠️</span>
          <div>{tl('等级表还没有配「绩点」，所以 GPA 与排名都是空的。到「成绩等级」里给每个等级填上绩点（并勾「计入GPA」）后重新结转即可。')}</div>
        </div>
      )}

      <MetricRow>
        <MetricCard label={tl('学生数')} value={data.summary.students} />
        <MetricCard label={tl('平均加权 GPA')} value={fmtNum(data.summary.avgGpa, 2)} />
        <MetricCard label={tl('全科达标人数')} value={data.summary.fullMarks} />
      </MetricRow>

      {data.gpaConfigured && (
        <Panel title={tl('GPA 分布')}>
          {data.distribution.map((b) => (
            <BarRow key={b.label} label={tl(b.label)} value={b.count} max={distMax} />
          ))}
        </Panel>
      )}

      <Panel
        title={tl('GPA 与班级排名')}
        extra={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOnlyTop(!onlyTop)}>
            {onlyTop ? tl('显示全部') : tl('只看前 20')}
          </button>
        }
      >
        <SimpleTable
          head={[tl('排名'), tl('学生'), tl('班级'), tl('班内排名'), tl('加权 GPA'), tl('不加权 GPA'), tl('平均总评'), tl('达标科目')]}
          rows={rows.map((r) => [
            r.rank ?? '—',
            r.studentName,
            r.cls,
            r.clsRank == null ? '—' : `${r.clsRank} / ${r.clsTotal}`,
            fmtNum(r.weightedGpa, 2),
            fmtNum(r.unweightedGpa, 2),
            fmtNum(r.avgTotal, 1),
            `${r.attainedCount} / ${r.subjectCount}`,
          ])}
        />
        {rows.length === 0 && <div className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tl('该班级在该批次下还没有总评记录')}</div>}
      </Panel>

      <Panel title={tl('口径说明')}>
        <div className="muted" style={{ fontSize: 'var(--font-xs)', lineHeight: 1.9 }}>
          · {tl('先把「学生 × 批次 × 科目」的总评按学生聚合成一行，再排名 —— 否则同一个学生会占据前几名。')}
          <br />· {tl('加权 GPA = 各科加权 GPA 的平均（科目等权，ACMS 不做学分制）；没有配绩点的科目不进这个平均。')}
          <br />· {tl('排名用竞赛法：同分同名次，下一名跳号（1、1、3）。与期末总评页里的排名口径一致。')}
          <br />· {tl('数据范围：')}{data.scopeNote ?? ''}
          <br />· {tl('「班内排名」按每个学生自己的班级分别计算；跨班比较请用总排名。')}
        </div>
      </Panel>
    </>
  );
}

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { api, type Page, type StudentRecord } from '../../lib/api';
import { useTranslations } from 'next-intl';
import { StudentForm } from '../../components/StudentForm';
import Pagination from '../../components/Pagination';
// 下拉筛选统一走全站组件（2026-09-22）：本页此前自带一份副本 —— 只显示标签、看不出当前
// 筛了什么，与全站「标签：当前值」的长相不一致。多选能力已并入统一组件（`multiple`）。
import { FilterSelect } from '../../components/FilterSelect';
// 按钮门控：判据 = `module:students:<动作>`，与后端 authorize() 同一套点（2026-09-17 收口）
import { usePermissions } from '../../lib/permissions';

const COLS = [
  { key: '学生姓名', label: 'colStudent', width: '' },
  { key: '英文名', label: 'colEnglishName', width: '120px' },
  { key: '性别', label: 'colGender', width: '64px' },
  { key: 'Arete毕业届', label: 'colAreteGraduation', width: '110px' },
  { key: '入学年级', label: 'colAreteClass', width: '' },
  { key: '来源渠道', label: 'colSource', width: '80px' },
  { key: '生源跟进状态', label: 'colFollowUp', width: '80px' },
  { key: '更新时间', label: 'colUpdated', width: '140px' },
  { key: '当前状态', label: 'common.status', width: '100px' },
];

/**
 * 报表下钻允许透传的查询条件（与后端 StudentFilterDto 的字段一致）。
 * 报表点某个维度值 → 跳 /students?字段=值，本页把这些条件合并进筛选。
 */
const DRILL_KEYS = [
  '当前状态', '入学年级', '当前年级', '班主任', '招生负责老师', '升学导师',
  '来源渠道', '生源跟进状态', '入学年份', 'Arete毕业届', '校区', '性别',
  '是否是新生', '数据密级',
];

/**
 * URL 传进来要转成数组的键：多选筛选器（回显需要数组）与人员字段（存 open_id 数组）。
 * 升学导师页面上没有筛选控件，但存储同样是 open_id，走数组分支才会做姓名还原。
 */
const DRILL_MULTI_KEYS = ['当前状态', '班主任', '招生负责老师', '升学导师'];

/** 其中页面上没有对应筛选控件的键 —— 下钻进来时用户看不到条件，必须显式提示 */
const DRILL_HIDDEN_KEYS = ['校区', '性别', '升学导师', '是否是新生', '数据密级'];

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/** 提取照片 token */
function getPhotoToken(rec: Record<string, unknown>): string | null {
  const v = rec['学生照片'];
  if (!v) return null;
  if (Array.isArray(v) && v.length) {
    const item = v[0] as any;
    return item.file_token ?? (typeof item === 'string' ? item : null);
  }
  if (typeof v === 'object' && (v as any).file_token) return (v as any).file_token;
  return null;
}

/** 浏览器可直接访问的照片 URL：优先后端换发的免 token 临时链接，其次走代理 */
function getPhotoUrl(rec: Record<string, unknown>): string | null {
  const v = rec['学生照片'];
  if (Array.isArray(v) && v.length) {
    const item = v[0] as any;
    if (item?.viewUrl) return item.viewUrl;
    if (item?.file_token) return `/api/v1/files/${encodeURIComponent(item.file_token)}`;
  }
  return null;
}

/** 格式化时间戳（秒或毫秒）为 YYYY-MM-DD HH:mm */
function fmtDate(v: unknown): string {
  if (!v) return '';
  const n = Number(v);
  if (!n || isNaN(n)) return String(v);
  // 判断是秒还是毫秒（毫秒 > 1e12）
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(v);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function avatarColor(name: string): string {
  const colors = ['avatar-teal', 'avatar-emerald', 'avatar-amber', 'avatar-rose'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function statusClass(status: string): string {
  if (status === '在校在读' || status === '已录未报到' || status === '潜在学生') return 'status-active';
  if (status === '毕业') return 'status-graduated';
  return 'status-left';
}

export default function StudentsPage() {
  const t = useTranslations('students');
  const c = useTranslations('common');
  const cr = useTranslations('crud');
  const n = useTranslations('nav');
  const colText = (k: string) => (k.startsWith('common.') ? c(k.slice(7)) : t(k));

  /**
   * 按钮级权限（2026-09-17 补）。
   *
   * ⚠️ 此前本页**一个权限判断都没有** —— 编辑/删除按钮对所有人显示。
   * 而它又是自建页面（不走 CrudPage 的 moduleKey 门控），所以全站按钮收口那轮没覆盖到。
   * 判据必须与后端 `StudentService` 保持同一套点（那里已从 legacy `student:write/archive`
   * 收口为 `module:students:*`），否则又会出现「按钮隐藏 ⇔ 接口 403」对不上的老问题。
   */
  const perms = usePermissions();
  const canCreate = perms.includes('module:students:create');
  const canUpdate = perms.includes('module:students:update');
  const canDelete = perms.includes('module:students:delete');
  /** 「导出学生档案」后端走导出工作台判据（`module:export:read`）+ 学生读权限 */
  const canExport = perms.includes('module:export:read') && perms.includes('module:students:read');
  /** 操作列（编辑/删除）是否整列渲染 */
  const canWriteAny = canUpdate || canDelete;

  const [items, setItems] = useState<StudentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const tokenStack = useRef<(string | undefined)[]>([]); // tokenStack[i] = 拉取第 i+1 页所需的 pageToken
  // 每页条数可在分页条上切换；切换后 buildParams → fetchPage 重建，
  // 下方 [q, filters, fetchPage] 的 effect 会重置游标并回到第 1 页。
  const [size, setSize] = useState(10);
  const PAGE_SIZE = size;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  // 「来源渠道 / 生源跟进状态」两项已随筛选框一起移除（2026-09-22）：留着空值只会在
  // 请求参数里多带两个恒为空的字段，将来接手的人会以为它们还有用。
  const [filters, setFilters] = useState<Record<string, string | string[]>>({
    当前状态: [],
    入学年级: '',
    当前年级: '',
    班主任: [],
    招生负责老师: [],
    入学年份: '',
    Arete毕业届: '',
  });

  const [dicts, setDicts] = useState<Record<string, string[]>>({});

  useEffect(() => {
    api.dictionaries().then((d) => {
      if (d) setDicts(d);
    }).catch(() => {});
  }, []);

  /** 教师用户（班主任 / 招生负责老师 下拉框数据源） */
  const [headTeacherOptions, setHeadTeacherOptions] = useState<string[]>([]);
  const [recruitOptions, setRecruitOptions] = useState<string[]>([]);
  /** 通讯录映射是否已就绪（下钻筛选要等它，见下方 effect） */
  const [userReady, setUserReady] = useState(false);
  /**
   * 我自己的学生数据范围说明（2026-09-15）。
   * 范围导致「看不到学生」有三层（人级配置 / 角色级 / ABAC 校区），
   * 表现都是空列表 —— 提示条要能说清是哪一层，否则排查又得从头查。
   */
  const [scopeInfo, setScopeInfo] = useState<{
    level: string;
    visible: number;
    total: number;
    campuses: string[];
    orgWide: boolean;
  } | null>(null);
  /** 来自报表下钻、但页面上没有筛选控件的条件（提示给用户，避免误以为筛选没生效） */
  const [drillChips, setDrillChips] = useState<{ label: string; value: string }[]>([]);
  /** 姓名 → 飞书 Open ID 映射（学生字段存的是 Open ID，筛选时需还原） */
  const nameToOpenId = useRef<Record<string, string>>({});
  /** 拉一次自己的范围说明（只读展示用，失败静默 —— 不该因为提示条拉不到就影响列表） */
  useEffect(() => {
    let alive = true;
    api
      .myStudentScope()
      .then((r) => {
        if (alive) setScopeInfo(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const collected: { name: string; openId: string; teacherType: string }[] = [];
    const fetchPage = async (): Promise<void> => {
      // ⚠️ 用 /users/directory（全员可读）而不是 listUsers（需 admin:user）：
      // 教务/招生/班主任等角色没有 admin:user，用后者会 403，筛选项永远为空。
      const list = await api.listUserDirectory();
      for (const u of list) {
        collected.push({ name: u.name, openId: u.openId, teacherType: u.teacherType });
      }
    };
    fetchPage()
      .then(() => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const u of collected) if (u.name && u.openId) map[u.name] = u.openId;
        nameToOpenId.current = map;
        const named = collected.filter((u) => u.name);
        setHeadTeacherOptions(named.filter((u) => u.teacherType === '班主任').map((u) => u.name));
        setRecruitOptions(named.filter((u) => u.teacherType === '招生老师').map((u) => u.name));
      })
      .catch(() => {})
      // 映射成功与否都要放行下钻：否则拿不到通讯录时页面永远卡在「无筛选」状态
      .finally(() => {
        if (alive) setUserReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 从报表下钻进来时把 URL 上的查询条件写进筛选（学生结构概览 / 年级升级流向等）。
   *
   * ⚠️ 必须等通讯录映射就绪（userReady）再写：班主任 / 招生负责老师 / 升学导师 在学生表里
   * 存的是 open_id，映射没建好就提交筛选，会把姓名当 open_id 传过去，结果恒为空列表。
   */
  useEffect(() => {
    if (!userReady) return;
    const qs = new URLSearchParams(window.location.search);
    if (!Array.from(qs.keys()).length) return;
    const next: Record<string, string | string[]> = {};
    const chips: { label: string; value: string }[] = [];
    for (const k of DRILL_KEYS) {
      const v = qs.get(k);
      if (!v) continue;
      next[k] = DRILL_MULTI_KEYS.includes(k) ? v.split(',').filter(Boolean) : v;
      if (DRILL_HIDDEN_KEYS.includes(k)) chips.push({ label: k, value: v });
    }
    if (Object.keys(next).length) setFilters((f) => ({ ...f, ...next }));
    setDrillChips(chips);
  }, [userReady]);

  const buildParams = useCallback(
    (token?: string): Record<string, string | undefined> => {
      const params: Record<string, string | undefined> = {
        pageSize: String(PAGE_SIZE),
        sortBy: '学籍号（脱敏）',
        sortOrder: 'asc',
      };
      if (q) params.q = q;
      for (const [k, v] of Object.entries(filters)) {
        if (Array.isArray(v) && v.length) {
          // 班主任 / 招生负责老师 / 升学导师 存的是 Open ID，下拉（或报表下钻）给的是姓名，需还原
          const ids = ['班主任', '招生负责老师', '升学导师'].includes(k)
            ? v.map((name) => nameToOpenId.current[name] ?? name).filter(Boolean)
            : v;
          if (ids.length) params[k] = ids.join(',');
        } else if (typeof v === 'string' && v) {
          // 人员字段即使只有一个值也要还原成 open_id（报表下钻可能只传一个姓名）
          const personKeys = ['班主任', '招生负责老师', '升学导师'];
          params[k] = personKeys.includes(k) ? (nameToOpenId.current[v] ?? v) : v;
        }
      }
      if (token) params.pageToken = token;
      return params;
    },
    [q, filters, PAGE_SIZE],
  );

  /** 拉取指定页（token 已知时直接拉；拉取后用返回 token 续填下一页游标） */
  const fetchPage = useCallback(
    async (target: number, token?: string) => {
      setLoading(true);
      setError('');
      try {
        const data: Page<StudentRecord> = await api.listStudents(buildParams(token));
        setItems(data.items);
        setTotal(data.total);
        setPage(target);
        tokenStack.current[target] = data.pageToken; // 第 target 页之后的游标
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [buildParams],
  );

  /** 跳转到目标页：若游标未知则向前逐页补全（不渲染中间页），再拉取目标页 */
  const goToPage = useCallback(
    async (target: number) => {
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      target = Math.min(Math.max(target, 1), totalPages);
      if (target - 1 < tokenStack.current.length) {
        await fetchPage(target, tokenStack.current[target - 1]);
        return;
      }
      for (let p = tokenStack.current.length; p < target; p++) {
        const data = await api.listStudents(buildParams(tokenStack.current[p - 1]));
        tokenStack.current[p] = data.pageToken;
      }
      await fetchPage(target, tokenStack.current[target - 1]);
    },
    [total, PAGE_SIZE, fetchPage, buildParams],
  );

  // 筛选 / 搜索变化 → 重置分页并从第 1 页重新加载
  useEffect(() => {
    tokenStack.current = [];
    setPage(1);
    fetchPage(1, undefined);
  }, [q, filters, fetchPage]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    tokenStack.current = [];
    setPage(1);
    fetchPage(1, undefined);
  };

  const setFilter = (key: string, val: string | string[]) => {
    setFilters((prev) => ({ ...prev, [key]: val }));
  };

  // 新建/编辑改为页内独立表单（URL 保持不变），与全站统一的 standaloneForm 交互一致
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; id: string } | null>(null);
  const [editStudent, setEditStudent] = useState<StudentRecord | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');
  /** 新建成功提示：与原 /students/new 一致，保存后停留在本页以便继续上传照片与附件 */
  const [createMsg, setCreateMsg] = useState('');

  /** 列表接口不解析「证件与文件」附件（仅详情接口 resolveDocFiles 才解析），
   *  故编辑前必须按 id 拉取完整记录，否则附件会显示为空并在保存时丢失。 */
  function openEdit(id: string) {
    setEditing({ mode: 'edit', id });
    setEditStudent(null);
    setEditError('');
    setEditLoading(true);
    api
      .getStudent(id)
      .then((data) => setEditStudent(data))
      .catch((e) => setEditError((e as Error).message))
      .finally(() => setEditLoading(false));
  }

  function openCreate() {
    setCreateMsg('');
    setEditing({ mode: 'create' });
  }

  function closeForm() {
    setEditing(null);
    setEditStudent(null);
    setCreateMsg('');
  }

  /** 编辑保存后：关闭表单并回到列表第一页刷新 */
  function handleEditDone() {
    closeForm();
    tokenStack.current = [];
    setPage(1);
    fetchPage(1, undefined);
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t('confirmDeleteStudent'))) return;
    try {
      await api.archiveStudent(id);
      tokenStack.current = [];
      setPage(1);
      fetchPage(1, undefined);
    } catch (e) {
      alert(cr('deleteFailed'));
    }
  };

  if (editing) {
    const isEdit = editing.mode === 'edit';
    return (
      <div>
        <div className="page-header">
          <div className="page-header-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
              <button className="btn btn-icon" title={c('back')} aria-label={c('back')} onClick={closeForm}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <div>
                <div className="page-eyebrow">{isEdit ? 'EDIT' : 'CREATE'} / {n('students')}</div>
                <h1 className="page-title">{isEdit ? c('edit') : c('create')}{n('students')}</h1>
              </div>
            </div>
          </div>
        </div>

        {isEdit ? (
          editLoading ? (
            <div className="empty-state">{c('loading')}</div>
          ) : editError || !editStudent ? (
            <div>
              <p className="msg-error">{c('loadFailed')}：{editError}</p>
              <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={closeForm}>{c('back')}</button>
            </div>
          ) : (
            <StudentForm initial={editStudent} onSubmit={handleEditDone} />
          )
        ) : (
          <>
            {createMsg && <p className="msg-success">{createMsg}</p>}
            <StudentForm
              onSubmit={() => setCreateMsg(t('msgCreatedKeepUploading'))}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* ── Page header ──────────────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-md)' }}>
            <h1 className="page-title">{n('students')}</h1>
            <span className="stat-inline">{t('resultCount', { total })}</span>
          </div>
          <p className="page-subtitle">{t('subtitleList')}</p>
          <div className="page-actions">
            {canExport && (
            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                const params: Record<string, string | undefined> = {};
                if (q) params.q = q;
                for (const [k, v] of Object.entries(filters)) {
                  if (Array.isArray(v) && v.length) {
                    const ids = ['班主任', '招生负责老师'].includes(k)
                      ? v.map((name) => nameToOpenId.current[name] ?? name).filter(Boolean)
                      : v;
                    if (ids.length) params[k] = ids.join(',');
                  } else if (typeof v === 'string' && v) params[k] = v;
                }
                api.exportStudents(params).then((csv) => {
                  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = 'students.csv'; a.click();
                });
              }}
            >
              ↓ {t('btnExportAuth')}
            </button>
            )}
            {canCreate && (
            <button className="btn btn-primary" onClick={openCreate}>
              + {t('btnNewStudent')}
            </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 数据范围提示条 ─────────────────────
          范围受限时必须让用户知道「为什么少」，并区分是哪一层限制的
          （人级 / 角色级 / 校区），否则表现和「系统坏了」没区别。
          🔴 2026-09-18 新增 role-none：角色没配数据范围 ⇒ 一条都看不到 ——
             这种「空列表」最容易被误判成系统故障，必须显式说清楚。 */}
      {scopeInfo && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 12px',
            marginBottom: 'var(--space-md)',
            borderRadius: 8,
            fontSize: 'var(--font-sm)',
            background:
              scopeInfo.level === 'none' || scopeInfo.level === 'org' || scopeInfo.level === 'role-all'
                ? 'var(--bg-subtle)'
                : 'var(--accent-muted)',
            border: `1px solid ${
              scopeInfo.level === 'none' || scopeInfo.level === 'org' || scopeInfo.level === 'role-all'
                ? 'var(--border)'
                : 'var(--accent-soft)'
            }`,
            color:
              scopeInfo.level === 'none' || scopeInfo.level === 'org' || scopeInfo.level === 'role-all'
                ? 'var(--fg-secondary)'
                : 'var(--accent)',
          }}
        >
          <span style={{ fontWeight: 600 }}>{t('scopeBannerTitle')}</span>
          <span>
            {scopeInfo.level === 'none' || scopeInfo.level === 'org' || scopeInfo.level === 'role-all'
              ? t('scopeBannerOrg', { total: scopeInfo.total })
              : t('scopeBannerRestricted', { visible: scopeInfo.visible, total: scopeInfo.total })}
          </span>
          {scopeInfo.level === 'user-custom' && <span>· {t('scopeSrcUser')}</span>}
          {scopeInfo.level === 'user-all' && <span>· {t('scopeSrcUserAll')}</span>}
          {scopeInfo.level === 'role' && <span>· {t('scopeSrcRole')}</span>}
          {scopeInfo.level === 'role-all' && <span>· {t('scopeSrcRoleAll')}</span>}
          {scopeInfo.level === 'role-none' && <span>· {t('scopeSrcRoleNone')}</span>}
          {!scopeInfo.orgWide && scopeInfo.campuses.length > 0 && (
            <span>· {t('scopeCampus', { campuses: scopeInfo.campuses.join('、') })}</span>
          )}
        </div>
      )}

      {/* ── Search + filters ─────────────────── */}
      <form onSubmit={handleSearch} className="filter-bar">
        <div className="search-bar" style={{ flex: 1, minWidth: 200 }}>
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            placeholder={t('searchPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit">{t('btnQuery')}</button>
        </div>

        <FilterSelect
          label={c('status')}
          value={filters['当前状态'] as string[]}
          onChange={(v) => setFilter('当前状态', v)}
          options={dicts['当前状态'] ?? ['已录未报到', '在校在读', '离校未毕(休学）', '离校未毕(保留学籍）', '毕业', '退学', '放弃入学', '潜在学生']}
          multiple
        />
        <FilterSelect
          label={t('fldGrade')}
          value={filters['入学年级'] as string}
          onChange={(v) => setFilter('入学年级', v)}
          options={dicts['入学年级'] ?? ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '高一', '高二', '高三']}
        />
        <FilterSelect
          label={t('fldCurrentGrade')}
          value={filters['当前年级'] as string}
          onChange={(v) => setFilter('当前年级', v)}
          options={dicts['当前年级'] ?? ['Foundation', 'Pre-1', 'Pre-2', 'Pre-3', '大一', '未来企业家班', '全球领航计划']}
        />
        <FilterSelect
          label={t('fldHeadTeacher')}
          value={filters['班主任'] as string[]}
          onChange={(v) => setFilter('班主任', v)}
          options={headTeacherOptions}
          multiple
        />
        <FilterSelect
          label={t('fldRecruiter')}
          value={filters['招生负责老师'] as string[]}
          onChange={(v) => setFilter('招生负责老师', v)}
          options={recruitOptions}
          multiple
        />
        {/**
         * 「来源渠道」「生源跟进状态」两个筛选框**已按要求移除**（2026-09-22 峰哥）。
         *
         * 不是隐藏而是删掉：留着只是 `style={{display:'none'}}` 这类障眼法的话，
         * 初始 state 与请求参数里还得继续带着它们，将来接手的人会以为「这里本来有筛选却筛不动」。
         * 两列在**列表与 CSV 导出里照旧显示**（COLS 未动）—— 移除的是筛选入口，不是数据。
         */}
        <FilterSelect
          label={t('fldEnrollYear')}
          value={filters['入学年份'] as string}
          onChange={(v) => setFilter('入学年份', v)}
          options={dicts['入学年份'] ?? ['2021春', '2021秋', '2022春', '2022秋', '2023春', '2023秋', '2024春', '2024秋', '2025春', '2025秋', '2026春', '2026秋', '2027春', '2027秋']}
        />
        <FilterSelect
          label={t('fldAreteSession')}
          value={filters['Arete毕业届'] as string}
          onChange={(v) => setFilter('Arete毕业届', v)}
          options={dicts['Arete毕业届'] ?? ['第1届', '第2届', '第3届', '第4届', '第5届', '第6届']}
        />
      </form>

      {/* 来自报表的下钻条件（页面上没有对应筛选控件，不提示的话用户会以为筛选没生效） */}
      {drillChips.length > 0 ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBottom: '0.75rem',
            padding: '8px 12px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            fontSize: 'var(--font-sm)',
            color: 'var(--fg-secondary)',
          }}
        >
          <span style={{ color: 'var(--fg-tertiary)' }}>{c('drillFromReport')}</span>
          {drillChips.map((x) => (
            <span
              key={x.label}
              style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--bg-hover)', fontSize: 'var(--font-xs)' }}
            >
              {x.label}：{x.value}
            </span>
          ))}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => window.location.assign('/students')}
          >
            {c('clear')}
          </button>
        </div>
      ) : null}

      {/* ── Error / Loading ──────────────────── */}
      {error && <p className="msg-error">{c('loadFailed')}</p>}
      {loading && items.length === 0 && (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
      )}

      {/* ── Data table ───────────────────────── */}
      {!loading || items.length > 0 ? (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {COLS.map((col) => (
                    <th key={col.key} style={col.width ? { width: col.width } : undefined}>{colText(col.label)}</th>
                  ))}
                  {canWriteAny && <th style={{ width: 120 }}>{c('actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const name = str(s['学生姓名']) || '—';
                  const status = str(s['当前状态']);
                  return (
                    <tr key={s.id}>
                      {/* 学生 / 编号（超链接 + 缩略图） */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {getPhotoUrl(s) ? (
                            <div className="photo-thumb">
                              <img
                                src={getPhotoUrl(s)!}
                                alt={name}
                                className="avatar-dot"
                                style={{ width: 34, height: 34, objectFit: 'cover' }}
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                              />
                              <div className="photo-tip" role="tooltip">
                                <img src={getPhotoUrl(s)!} alt={name} />
                              </div>
                            </div>
                          ) : (
                            <span className={`avatar-dot ${avatarColor(name)}`}>{name.charAt(0)}</span>
                          )}
                          <Link href={`/students/${s.id}`} className="name-link">
                            <div style={{ fontWeight: 600, fontSize: 'var(--font-sm)' }}>{name}</div>
                            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{str(s['学生编号']) || '—'}</div>
                          </Link>
                        </div>
                      </td>
                      {/* 英文名 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['英文名']) || '—'}</td>
                      {/* 性别 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['性别']) || '—'}</td>
                      {/* Arete毕业届 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['Arete毕业届']) || '—'}</td>
                      {/* Arete班（年级/班级）：当前年级为主（加粗置顶），入学年级为次（小字置底） */}
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 'var(--font-sm)' }}>{str(s['当前年级']) || t('noClass')}</div>
                        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{str(s['入学年级']) || '—'}</div>
                      </td>
                      {/* 来源渠道 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['来源渠道']) || '—'}</td>
                      {/* 跟进状态 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['生源跟进状态']) || '—'}</td>
                      {/* Updated */}
                      <td style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
                        {fmtDate(s['更新时间']) || '—'}
                      </td>
                      {/* Status（移到更新列后）→ 只显示状态；性别已独立成列，不再挂在状态下面 */}
                      <td>
                        <div className={`status-dot ${statusClass(status)}`}>{status || '—'}</div>
                      </td>
                      {/* Actions: 编辑 + 删除（各自按权限显隐） */}
                      {canWriteAny && (
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {canUpdate && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ padding: '4px 10px', fontSize: 'var(--font-xs)' }}
                            onClick={() => openEdit(String(s.id))}
                          >
                            {c('edit')}
                          </button>
                          )}
                          {canDelete && (
                          <button
                            className="btn btn-danger btn-sm"
                            style={{ padding: '4px 10px', fontSize: 'var(--font-xs)' }}
                            onClick={() => handleDelete(s.id)}
                          >
                            {c('delete')}
                          </button>
                          )}
                        </div>
                      </td>
                      )}
                    </tr>
                  );
                })}
                {!loading && items.length === 0 && (
                  <tr>
                      <td colSpan={COLS.length + (canWriteAny ? 1 : 0)}>
                      <div className="empty-state">
                        <div className="empty-state-text">{t('emptyNoStudents')}</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer：分页（默认每页 10 条，可切换条数 / 跳页；按学籍号升序） */}
          <Pagination
            total={total}
            page={page}
            pageSize={PAGE_SIZE}
            loading={loading}
            onPageChange={goToPage}
            onPageSizeChange={setSize}
          />
        </>
      ) : null}
    </div>
  );
}

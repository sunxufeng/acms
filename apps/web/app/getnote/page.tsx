'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import Markdown from '../../components/Markdown';
import { api, type GetnoteCredential, type GetnoteOAuthStart, type ApiRequestError, type RefetchAudioProgress } from '../../lib/api';
import type { NoteConvertTarget, NoteConvertLogItem, NoteConfigMapItem } from '@acms/contracts';
// 「来源 / 标签」的拆分规则与来源候选值都来自 contracts：后端做服务端筛选用的是同一份实现，
// 前端各写一份会出现「列里显示来源=得到大脑、按它筛却筛不到」这类对不上的问题。
// 状态（有效 / 归档）同理：**判据必须共用 contracts 的 `noteStatusMatches`** ——
// 本页在「来源 / 配置名称」那条客户端内存筛选分支里也要判状态，
// 各写一份必然漂移（症状：筛了来源之后状态筛选失灵）。
import {
  NOTE_SOURCE_TYPES,
  NOTE_STATUS_ACTIVE,
  NOTE_STATUS_ARCHIVED,
  NOTE_STATUS_FILTER_OPTIONS,
  hiddenArchivedCount,
  isArchivedNote,
  noteStatusMatches,
  noteTagNames,
  splitNoteTags,
} from '@acms/contracts';
import { putConvertPayload, formatConvertLogs, totalConvertCount, CONVERT_QUERY_FLAG, CONVERT_QUERY_VALUE } from '../../lib/noteConvert';
import { useTl } from '../../lib/useTl';
// 按钮级门控：归档 / 激活与后端同一个权限点（module:getnote:update）
import { usePermissions } from '../../lib/permissions';
// 行内播放（操作列 ▶/⏸）已抽成通用 hook，学生记录等附件字段的列表共用同一份逻辑
import { useRowAudio } from '../../lib/rowAudio';
import { useTranslations } from 'next-intl';

/** 开放平台（用户去这里创建应用、拿 Client ID 与 API Key） */
const OPENAPI_URL = 'https://www.biji.com/openapi';
/** 官方给出的会员开通页（错误码 10201 时引导到这里） */
const CHECKOUT_URL = 'https://www.biji.com/checkout?product_alias=9Ab36BB3ZD';

/**
 * 笔记来源的候选项 = 字典「笔记类型」。
 *
 * ⚠️ 存储位置：Get笔记 的 note 对象没有自定义字段，所以「来源」复用 **tags** 承载 ——
 *    命中这份字典的那个标签就是来源，其余标签才是普通标签。这样来源随笔记走、
 *    换浏览器也在，且不需要在 ACMS 侧再建映射表。
 *    toRow() 负责拆（来源 / 标签），toPayload() 负责合（提交时拼回 tags）。
 */
/**
 * 来源候选与「来源 / 标签」的拆分规则**统一放在 contracts**：
 * 后端要用同一份规则做服务端筛选（`GetnoteService.applyNoteFilters`），
 * 两边各写一份必然漂移 —— 症状是「列里显示来源=得到大脑，按得到大脑筛却筛不到」。
 */
// spread 成可变数组：列定义的 `options` 是 `string[]`，而 contracts 里是只读元组
const NOTE_TYPES: string[] = [...NOTE_SOURCE_TYPES];

function tagNames(n: Record<string, unknown>): string[] {
  return noteTagNames(n.tags);
}

/**
 * 详情 / 列表行里「已落库的原始音频」元信息。
 *
 * 后端在**详情与列表**返回里都附 `_audio`（只有真下载落库过才有）。没有就返回 null ——
 * 详情弹窗据此**不渲染播放器**，列表行据此**不渲染播放按钮**，
 * 避免给用户一个点了报错的空壳控件。
 *
 * ⚠️ 播放地址是 `/api/v1/getnote/notes/:id/audio`，**不是**通用的 `/files/:token`：
 *    那个接口登录即可下载，而录音是私密内容；专用接口会做笔记级可见性校验。
 */
interface NoteAudioMeta {
  token?: string;
  name?: string;
  size?: number;
  type?: string;
  durationMs?: number;
}

function audioOf(n: Record<string, unknown> | null): NoteAudioMeta | null {
  const a = n?._audio as NoteAudioMeta | null | undefined;
  return a && a.token ? a : null;
}

/**
 * 「这条笔记**有录音、但音频还没抓下来**」（未抓 / 上次失败）—— 后端 `_audioPending`。
 *
 * 🔴 判据必须在**后端**，不能靠前端猜 `note_type`（2026-09-22 修）：
 *    原先操作列只看 `note_type === 'recorder_audio'`，而峰哥报障的那 8 条
 *    **笔记类型并不是 recorder_audio**（正文字段由同步写回，各来源不一）
 *    ⇒ 这些「有录音却没抓」的行在列表里**什么都不显示**，跟纯文本笔记长得一样，
 *    只能靠人工全库体检才发现。
 *    后端用的是正文表里更硬的证据：`附件数 > 0 或 录音卡SN 非空`，且音频未入库。
 */
function audioPendingOf(n: Record<string, unknown> | null): boolean {
  return Boolean(n?._audioPending);
}

/** 音频播放地址（专用接口，带笔记级可见性校验） */
function audioSrc(noteId: string): string {
  return `/api/v1/getnote/notes/${encodeURIComponent(noteId)}/audio`;
}

/** 毫秒 → `12:34`（音频播放器旁边显示时长用） */
function fmtDuration(ms?: number): string {
  const sec = Math.round((Number(ms) || 0) / 1000);
  if (sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 把 Get笔记 的 note 对象适配成 CrudPage 的行数据。
 *
 * ⚠️ 两条硬约束：
 * 1. **CrudPage 用 `row.id` 作行键**（取值、编辑、删除全走它），而 Get笔记 的 ID 字段叫
 *    `note_id`，且是 int64 的字符串形态 —— 映射过去，**绝不能转 Number**（会丢精度，
 *    末几位变 0，导致编辑/删除命中错误的笔记）。
 * 2. `tags` 是对象数组 `[{id,name,type}]`，列表里渲染成可点击的标签；其中命中
 *    NOTE_TYPES 的那一个单独提成「来源」列，不再重复出现在标签列。
 */
function toRow(n: Record<string, unknown>): Record<string, unknown> {
  // 「来源 / 标签」的拆分口径来自 contracts（与后端筛选同一份实现）：
  // 命中来源字典的那个标签算「来源」，其余才是普通标签；历史笔记没有来源标签，默认「得到大脑」
  const { source: src, tags: plainTags } = splitNoteTags(n.tags);
  return {
    ...n,
    id: String(n.note_id ?? n.id ?? ''),
    来源: src,
    标签: plainTags.join('、'),
    // 状态来自后端的 `_status`（ACMS 自建表，见 GetnoteService.attachNoteStatus）。
    // 没有状态行（历史笔记）= 有效，所以这里必须走归一函数、不能只认 `=== '归档'` 的反面。
    状态: isArchivedNote(n._status) ? NOTE_STATUS_ARCHIVED : NOTE_STATUS_ACTIVE,
  };
}

/** 提交前把「来源 + 标签」合并回 tags（Get笔记 的 tags 是替换语义，必须整体传） */
function toPayload(d: Record<string, unknown>): Record<string, unknown> {
  const { 标签, 来源, ...rest } = d;
  const list =
    typeof 标签 === 'string'
      ? 标签.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(标签)
        ? (标签 as string[]).map((s) => String(s).trim()).filter(Boolean)
        : [];
  const src = typeof 来源 === 'string' ? 来源.trim() : '';
  return { ...rest, tags: src ? [...list, src] : list };
}

/**
 * 列定义做成工厂函数：标签列要渲染成可点击的 chip，点击后把标签名作为语义检索词
 * 传回列表（点击回调需要闭包捕获，模块级常量做不到，所以用 useMemo 包一层）。
 */
function makeColumns(
  onTagClick: (tag: string) => void,
  onTitleClick: (id: string) => void,
  /** 笔记 id → 转换留痕列表（外部批量查好后传入，「已转」列据此渲染） */
  convertLogs: Record<string, NoteConvertLogItem[]> = {},
  /** 笔记 id → 归属配置（「配置名称」列据此渲染） */
  configMap: Record<string, NoteConfigMapItem> = {},
  /** 知识库配置名列表：「配置名称」列的筛选项 */
  configOptions: string[] = [],
  /**
   * 归属人候选（「归属人」列的筛选项）。
   * 取值来自各知识库配置的「关联用户」—— 那就是「谁可能拥有笔记」的完整集合；
   * 比从当前页数据里动态收集更稳（翻页不会让候选消失）。
   */
  ownerOptions: string[] = [],
  /**
   * 配置 id → 配置表里的**当前**名称。
   * 显示时优先用它，改了名列表自动跟着变；查不到才退回映射表里存的名称快照。
   */
  configNameById: Record<string, string> = {},
  /**
   * 当前用户是不是系统管理员。
   * 只有管理员看得到「归属人」列 —— 管理员的列表是跨所有启用配置聚合出来的，
   * 必须能分辨每条笔记是谁的；普通用户看到的本来全是自己的，这列纯属噪音。
   */
  isAdmin = false,
): CrudColumn[] {
  return [
    {
      key: 'title',
      label: '标题',
      form: true,
      type: 'text',
      required: true,
      width: '280px',
      listOrder: 1,
      // 标题可点击：点开笔记详情弹窗（不触发行上的「点击编辑」）
      // 已归档的笔记在标题后挂一个灰色标记 —— 不新增「状态」列（列表已经很密），
      // 但归档与否必须一眼看得出，否则「都在列表里、为什么这条转不了」没法解释。
      render: (v, row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
          <button
            type="button"
            title="查看笔记详情"
            onClick={(e) => {
              e.stopPropagation();
              onTitleClick(String(row.id));
            }}
            style={{
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontWeight: 600,
              color: isArchivedNote(row['状态']) ? 'var(--fg-secondary)' : 'var(--accent)',
              textDecoration: 'underline',
              fontSize: 'inherit',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {String(v ?? '') || '（无标题）'}
          </button>
          {isArchivedNote(row['状态']) && (
            <span
              title={String(row['_archivedBy'] ?? '') ? `由 ${String(row['_archivedBy'])} 归档` : '已归档'}
              style={{
                flex: '0 0 auto',
                padding: '1px 8px',
                fontSize: 11,
                lineHeight: 1.7,
                borderRadius: 999,
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
                color: 'var(--fg-tertiary)',
                cursor: 'default',
              }}
            >
              已归档
            </span>
          )}
        </span>
      ),
    },
    /**
     * 状态（2026-09-21 峰哥要求）：**只做筛选、不占列**。
     * 与「来源」列同款做法 —— `list: false` 让它在列表里不渲染，`filter: true` 保留筛选能力。
     * `filterDefault: 有效` ⇒ 一进页面默认只看有效（归档的笔记被收起，顶部会提示隐藏了多少条）；
     * 想看归档的把下拉切到「全部」或「归档」。
     */
    {
      key: '状态',
      label: '状态',
      list: false,
      filter: true,
      filterType: 'select',
      filterOptions: [...NOTE_STATUS_FILTER_OPTIONS],
      filterDefault: NOTE_STATUS_ACTIVE,
      width: '96px',
      listOrder: 1.5,
      hint: '「归档」只是在本系统里把笔记收起来，不会删除 Get笔记 里的笔记',
    },
    { key: 'note_type', label: '类型', width: '100px', listOrder: 2 },
    {
      key: '来源',
      label: '来源',
      // 2026-09-17 峰哥要求：列表里**不显示**「来源」列。
      // 只是不展示 —— 筛选（filter）与编辑表单（form）都保留，能力不受影响。
      list: false,
      form: true,
      type: 'select',
      dictKey: '笔记类型',
      options: NOTE_TYPES,
      width: '120px',
      listOrder: 3,
      filter: true,
      filterType: 'select',
      hint: '这条笔记来自哪个渠道；存在 Get笔记 的标签里，随笔记走',
    },
    // 配置名称：这篇笔记属于哪个「知识库配置」。
    // ⚠️ 关联为什么记在 ACMS 侧：Get笔记 的 note 对象里**没有任何字段**能标识归属 ——
    //    source 恒为 "app"（平台自己的来源标识，指手机 App 录音）、note_type 是录音类型、
    //    tags 里也没有配置名。所以归属记在飞书「笔记配置映射」表：自动同步时写入，
    //    历史笔记用 scripts/backfill_note_config_map.mjs 补。没有记录的显示「—」。
    //    listOrder 取 3.5 是为了夹在「来源(3)」与「标签(4)」之间，不必重排已有列序号。
    {
      key: '配置名称',
      label: '配置名称',
      // 2026-09-17 峰哥要求：列表里**不显示**「配置名称」列（筛选保留）。
      list: false,
      width: '180px',
      listOrder: 3.5,
      filter: true,
      filterType: 'select',
      options: configOptions,
      render: (_v, row) => {
        const name = configDisplayName(configMap[String(row.id ?? '')], configNameById);
        if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        return (
          <span
            title={`配置：${name}`}
            style={{
              display: 'inline-block',
              maxWidth: 168,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              padding: '2px 10px',
              fontSize: 12,
              borderRadius: 999,
              lineHeight: 1.6,
              // ⚠️ 只用确定存在的变量：--bg-info / --fg-info / --border-info 全站没有，
              //    写了会静默失效（chip 变透明裸字）。沿用「已转」列的配色，靠 --accent 区分。
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              color: 'var(--accent)',
              cursor: 'default',
              verticalAlign: 'middle',
            }}
          >
            {name}
          </span>
        );
      },
    },
    // 归属人（仅管理员）。值来自后端聚合时打的 `_owner` 标记 ——
    // Get笔记 的 note 对象本身不带归属，只能由服务端在合并多源时补上。
    // listOrder 3.6：紧跟「配置名称(3.5)」，仍在「标签(4)」之前。
    ...(isAdmin
      ? [
          {
            key: '_owner',
            // ⚠️ key 用 `_owner`（后端聚合时打的行字段），但**筛选参数名是「归属人」**
            //    —— 后端 `GetnoteService` 读的是中文参数名 ⇒ 必须用 filterParam 映射。
            filter: true,
            filterParam: '归属人',
            filterType: 'select',
            filterOptions: ownerOptions,
            label: '归属人',
            width: '120px',
            listOrder: 3.6,
            render: (v: unknown) => {
              const name = String(v ?? '').trim();
              if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
              return (
                <span
                  style={{
                    display: 'inline-block',
                    maxWidth: 108,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    verticalAlign: 'middle',
                  }}
                >
                  {name}
                </span>
              );
            },
          } as CrudColumn,
        ]
      : []),
    {
      key: '标签',
      label: '标签',
      form: true,
      type: 'text',
      width: '200px',
      listOrder: 4,
      /**
       * 按标签筛选：**模糊包含**（一条笔记带多个标签，等值必然筛空）。
       * ⚠️ 刻意**不写** `filterOp: 'contains'` —— 那会给参数名加 `__contains` 后缀，
       *    而本接口是自建 controller（不是通用 CRUD），只认裸参数 `标签`，
       *    加了后缀会被当成未知参数**静默忽略**（筛选看起来没反应）。
       */
      filter: true,
      filterType: 'text',
      filterPlaceholder: '标签',
      hint: '多个标签用逗号分隔；保存后会整体替换原有标签',
      render: (v) => {
        const parts = String(v ?? '').split('、').map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        return (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
            {parts.map((p) => (
              <button
                key={p}
                type="button"
                className="btn btn-sm"
                title={`按「${p}」检索`}
                style={{ padding: '2px 10px', fontSize: 12, borderRadius: 999, lineHeight: 1.6 }}
                onClick={(e) => {
                  e.stopPropagation(); // 行上还有「点击编辑」，别一起触发
                  onTagClick(p);
                }}
              >
                {p}
              </button>
            ))}
          </span>
        );
      },
    },
    // 已转次数：留痕记在 ACMS 的「笔记转换记录」表，由 convertLogs 批量查出来后渲染。
    // listOrder 取 4.5 是为了夹在「标签(4)」与「更新时间(5)」之间，不必重排已有列序号。
    {
      key: '_converted',
      label: '已转',
      width: '110px',
      listOrder: 4.5,
      render: (_v, row) => {
        const logs = convertLogs[String(row.id ?? '')];
        const n = totalConvertCount(logs);
        if (!n) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        return (
          <span
            title={formatConvertLogs(logs)}
            style={{
              display: 'inline-block',
              padding: '2px 10px',
              fontSize: 12,
              borderRadius: 999,
              lineHeight: 1.6,
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              cursor: 'default',
            }}
          >
            已转 {n} 次
          </span>
        );
      },
    },
    { key: 'updated_at', label: '更新时间', width: '170px', listOrder: 5 },
    // 总结（content）= Get笔记 的 AI 智能总结，用 markdown 编辑器：带「MD / 浏览」切换，高度 420
    { key: 'content', label: '总结', form: true, type: 'markdown', fieldHeight: 420, list: false, listOrder: 6 },
    // 原始记录（rawRecord）= 录音类笔记的说话人带时间戳转写全文，仅详情接口返回，只读展示
    { key: 'rawRecord', label: '原始记录', form: true, type: 'textarea', readonly: true, fieldHeight: 360, list: false, listOrder: 7 },
  ];
}

/** 笔记详情弹窗：遮罩 + 容器样式（复用 CrudPage 的 --bg-elevated / --shadow-modal 变量） */
const detailOverlay: Record<string, unknown> = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
};
const detailModal: Record<string, unknown> = {
  background: 'var(--bg-elevated)',
  borderRadius: 12,
  padding: 20,
  width: 'min(880px, 100%)',
  maxHeight: '90vh',
  overflow: 'auto',
  boxShadow: 'var(--shadow-modal)',
};

/** 「转换」候选模块弹窗：遮罩复用详情弹窗的，容器更窄一些 */
const convertModal: Record<string, unknown> = {
  background: 'var(--bg-elevated)',
  borderRadius: 12,
  padding: 20,
  width: 'min(520px, 100%)',
  maxHeight: '80vh',
  overflow: 'auto',
  boxShadow: 'var(--shadow-modal)',
};

/** 来源筛选时最多翻多少页（防止笔记极多时把请求打满） */
const SOURCE_FILTER_MAX_PAGES = 10;

/**
 * 批量查「笔记属于哪个知识库配置」。
 * 后端单次最多接 100 个 id（防 URL 过长），超了分批再合并。
 */
async function fetchConfigMap(ids: string[]): Promise<Record<string, NoteConfigMapItem>> {
  const out: Record<string, NoteConfigMapItem> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const part = await api.listNoteConfigMap(ids.slice(i, i + 100));
    Object.assign(out, part);
  }
  return out;
}

/**
 * 归属记录 → 要显示的配置名。
 * 优先用配置表里的**当前**名称（改了名列表自动跟着变），查不到才退回映射表存的名称快照。
 */
function configDisplayName(
  hit: NoteConfigMapItem | undefined,
  configNameById: Record<string, string>,
): string {
  if (!hit) return '';
  return configNameById[hit.configId] || hit.configName || '';
}

/**
 * ⚠️ 每页条数必须与 Get笔记 服务端返回的单页条数一致。
 * Get笔记 的列表接口**不支持自定义 pageSize**，而 CrudPage 用 `total / pageSize` 推算总页数，
 * 两边不一致会让分页条显示的页数不对。拿到真实凭证后校准这个常量。
 */
const PAGE_SIZE = 20;

/** 把后端的结构化错误码翻成人话。光看 message 区分不了「非会员」和「Key 无效」。 */
function errorText(e: unknown, t: ReturnType<typeof useTranslations>): string {
  const code = (e as ApiRequestError)?.apiCode;
  if (code === 'GETNOTE_NOT_MEMBER') return t('errNotMember');
  if (code === 'GETNOTE_AUTH_FAILED') return t('errAuthFailed');
  if (code === 'GETNOTE_RATE_LIMITED') return t('errRateLimited');
  if (code === 'GETNOTE_BAD_INPUT') return (e as Error).message || t('errAuthFailed');
  return (e as Error)?.message || t('errGeneric');
}

export default function GetnotePage() {
  const tl = useTl();
  const t = useTranslations('getnote');
  const router = useRouter();

  const [cred, setCred] = useState<GetnoteCredential | null>(null); // null = 加载中
  /** 凭证状态拉取失败的原因。⚠️ 不能吞掉：吞了页面就永远停在「加载中…」，用户只会以为系统坏了 */
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false); // 设置区展开
  const [cid, setCid] = useState('');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  /**
   * 点击标签 → 用标签名做语义检索。与搜索框共用后端同一个 `q` 通道，
   * 二者互斥（点标签会覆盖搜索框）。这里单独存一份是为了在列表上方显示
   * 「按标签 X 检索」的提示条 —— 否则用户看到结果变了却不知道为什么。
   */
  const [tagQuery, setTagQuery] = useState('');

  // 笔记详情弹窗：点击列表标题拉取完整笔记内容（点标签检索互不影响）
  const [detailId, setDetailId] = useState('');
  const [detailNote, setDetailNote] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState('');
  // 详情弹窗的 Tab：总结 / 原始记录
  const [detailTab, setDetailTab] = useState<'summary' | 'raw'>('summary');

  /**
   * 「保存原始音频」任务进度。
   *
   * 为什么异步 + 轮询：上游 QPS 2、每条 0.6 秒，几百条要几分钟，同步等会被 nginx 掐成 504。
   * 范式与「知识库配置」页的「重新收取」一致（那边见 sources/page.tsx）。
   * 幂等 —— 已保存过的会被后端跳过，按钮可以放心再点。
   */
  const [audioJob, setAudioJob] = useState<RefetchAudioProgress | null>(null);
  const audioTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startSaveAudio = useCallback(async () => {
    if (audioTimerRef.current) {
      clearInterval(audioTimerRef.current);
      audioTimerRef.current = null;
    }
    const first = await api.refetchNoteAudio();
    setAudioJob(first);
    if (!first.running) return;
    audioTimerRef.current = setInterval(async () => {
      try {
        const p = await api.getRefetchAudioStatus();
        setAudioJob(p);
        if (!p.running && audioTimerRef.current) {
          clearInterval(audioTimerRef.current);
          audioTimerRef.current = null;
        }
      } catch {
        if (audioTimerRef.current) {
          clearInterval(audioTimerRef.current);
          audioTimerRef.current = null;
        }
      }
    }, 3000);
  }, []);

  /**
   * 行内播放（列表「操作」列的播放 / 停止按钮）。
   *
   * 逻辑已抽到 `lib/rowAudio.ts` 的 `useRowAudio`（2026-09-19）—— 学生记录等**附件字段**的列表
   * 也要用同一套（单实例 + ▶/⏸ 切换），两处各写一份必然漂移。
   * 这里只负责给出「播放地址怎么来」：笔记走**专用接口**（带笔记级可见性校验），
   * 不是通用的 `/files/:token`。
   */
  const rowAudioSrcOf = useCallback(
    (row: Record<string, unknown>) => audioSrc(String(row.id ?? '')),
    [],
  );
  const { playingId, toggle: toggleRowAudio } = useRowAudio(rowAudioSrcOf);

  // 笔记转换：候选目标模块 + 当前正在转换的笔记行
  const [convertTargets, setConvertTargets] = useState<NoteConvertTarget[]>([]);
  const [convertRow, setConvertRow] = useState<Record<string, unknown> | null>(null);
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertErr, setConvertErr] = useState('');
  /** 留痕写不进去时的黄色提示（不阻断转换，只是让用户知情） */
  const [convertWarn, setConvertWarn] = useState('');

  // ── 笔记状态（归档 / 激活，2026-09-21）───────────────────────────────
  /**
   * 被「状态」筛选挡掉的条数（服务端随列表返回）。默认视图只看有效，
   * 没有这个提示的话，管理员归档完会以为笔记丢了 —— 列表顶部据此显示
   * 「已隐藏 N 条已归档笔记（筛选「状态」选「全部」可查看）」。
   */
  const [archivedHidden, setArchivedHidden] = useState(0);
  /** 正在归档/激活的笔记 id（按钮转圈 + 防连点） */
  const [statusBusyId, setStatusBusyId] = useState('');
  /** 归档/激活失败提示（成功不提示 —— 行上的标记与按钮本身就是反馈） */
  const [statusErr, setStatusErr] = useState('');
  /**
   * 按钮权限：归档 / 激活走 `module:getnote:update`（矩阵里的「编辑」列）。
   *
   * 与后端同一个权限点；前端只负责「不显示点了会 403 的按钮」，真正拦得住的是接口。
   * ⚠️ 权限缓存是登录后拉一次（`lib/permissions.ts`）—— 管理员改了角色配置后，
   *    用户需要刷新/重登才会看到按钮变化，这与全站其它按钮的行为一致。
   */
  const perms = usePermissions();
  const canSetStatus = perms.includes('module:getnote:update');

  /**
   * 归档 / 激活。**不做二次确认**：归档是可逆的（旁边就是「激活」），
   * 而误点成本只是再点一下 —— 加弹窗反而拖慢批量整理笔记这个高频动作。
   */
  const setNoteStatus = useCallback(
    async (row: Record<string, unknown>, status: string, reload: () => void) => {
      const id = String(row.id ?? '');
      if (!id || statusBusyId) return;
      setStatusErr('');
      setStatusBusyId(id);
      try {
        await api.setGetnoteStatus(id, status, String(row.title ?? ''));
        reload();
      } catch (e) {
        setStatusErr(errorText(e, t));
      } finally {
        setStatusBusyId('');
      }
    },
    [statusBusyId, t],
  );
  /**
   * 当前页笔记的转换留痕：noteId → 留痕列表。
   * 留痕存在 ACMS 自己的表（不写 Get笔记 标签，因为上游单篇笔记最多 5 个标签），
   * 所以列表行要显示「已转 N 次」必须额外批量查一次。
   */
  const [convertLogs, setConvertLogs] = useState<Record<string, NoteConvertLogItem[]>>({});
  /** 正在查询中的笔记 id 集合，避免翻页时重复并发请求 */
  const convertLogsBusy = useRef<Set<string>>(new Set());
  /**
   * 「来源 / 配置名称」筛选用的全量行缓存。
   *
   * 这两个筛选项上游接口不支持，只能翻页收集全部笔记后在内存里筛 —— 每次切换配置名称
   * 都要重跑一遍翻页（最多 10 次往返）＋重拉归属映射，用户体感就是「切一下卡好几秒」。
   * 缓存后切换只在内存里过滤，秒出。取 5 分钟 TTL 兼顾新鲜度。
   */
  const allRowsCacheRef = useRef<{ at: number; rows: Record<string, unknown>[] } | null>(null);
  const ALL_ROWS_CACHE_TTL = 5 * 60 * 1000;

  /**
   * 知识库配置列表：给「配置名称」列当筛选项，同时提供 配置id → 当前名称 的查表
   * （改名后列表自动跟着变，不必重新同步）。
   */
  const [configSources, setConfigSources] = useState<Record<string, unknown>[]>([]);
  /** 笔记 id → 归属配置。翻页时做**合并**而非替换，避免上一页的映射被清掉。 */
  const [configMap, setConfigMap] = useState<Record<string, NoteConfigMapItem>>({});
  /**
   * 系统管理员标记。决定「归属人」列是否出现 —— 管理员的列表是跨所有启用配置
   * 聚合出来的，混着多个人的笔记，必须能看出来每条是谁的。
   */
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((u) => setIsAdmin(Boolean((u as { roles?: string[] })?.roles?.includes('系统管理员'))))
      .catch(() => {
        /* 拿不到就按普通用户渲染，不加「归属人」列即可 */
      });
  }, []);

  useEffect(() => {
    api
      .listGetnoteSources({ pageSize: '100' })
      .then((r) => setConfigSources(r.items ?? []))
      .catch(() => {
        /* 配置列表拿不到不影响笔记列表本身，只是「配置名称」列显示不出来 */
      });
  }, []);

  const configOptions = useMemo(
    () =>
      Array.from(
        new Set(configSources.map((s) => String(s['配置名称'] ?? '').trim()).filter(Boolean)),
      ),
    [configSources],
  );

  /**
   * 归属人候选：只取各配置「关联用户」里的人名。
   *
   * 「关联用户」在列表接口里已被后端解析成「张三、李四」这样的展示串（`__link` 才是 id），
   * 所以按「、」拆即可。
   *
   * 🔴 **不要再把旧字段「归属人」也收进来**（2026-09-17 移除）。它是单人归属时代的**手填文本**，
   *    **不随用户表改名**；与「关联用户」并存时会让同一个人冒出两种写法：
   *    实测那条配置 `归属人='孙旭峰'` / `关联用户='孙旭峰｜Richard'`
   *    ⇒ 下拉出现两个「孙旭峰」，而笔记数据里该人的 `_owner` 只有带英文名那个
   *    （本人凭证源先入列，`_owner` 用的是会话姓名）⇒ 选旧写法的那个选项**必然筛出 0 条**。
   *    其余 11 条配置两套字段本来就逐字相同（被 Set 去重），所以只有本人看得见这个问题。
   *
   * 移除兜底是安全的：已核对生产全部 12 条配置的「关联用户」**均非空**，
   * 且新建配置时后端默认把自己写进「关联用户」（`sources.service.ts` 的 create 钩子）。
   */
  const ownerOptions = useMemo(() => {
    const set = new Set<string>();
    const push = (v: unknown) => {
      String(v ?? '')
        .split(/[、,，]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((x) => set.add(x));
    };
    for (const s of configSources) push(s['关联用户']);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
  }, [configSources]);

  const configNameById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of configSources) {
      const id = String(s.id ?? s.recordId ?? '');
      if (id) out[id] = String(s['配置名称'] ?? '');
    }
    return out;
  }, [configSources]);

  /** 列表行变化后批量拉一次留痕（一次请求拿全，不逐行打接口） */
  const onRowsLoaded = useCallback((rows: Record<string, unknown>[]) => {
    const ids = rows.map((r) => String(r.id ?? '')).filter(Boolean);
    if (!ids.length) {
      setConvertLogs({});
      setConfigMap({});
      return;
    }
    const need = ids.filter((id) => !convertLogsBusy.current.has(id));
    if (!need.length) return;
    for (const id of need) convertLogsBusy.current.add(id);

    // 归属映射：与留痕并列查一次（同一批 id），结果**合并**进已有，翻页不丢
    void fetchConfigMap(need)
      .then((map) => setConfigMap((prev) => ({ ...prev, ...map })))
      .catch(() => {
        /* 归属查不到只是「配置名称」列显示「—」，不影响列表本身 */
      });

    api
      .listNoteConverts(need)
      .then((map) => {
        setConvertLogs((prev) => {
          const next = { ...prev };
          for (const id of need) {
            if (map[id]?.length) next[id] = map[id];
            else delete next[id];
          }
          return next;
        });
      })
      .catch(() => { /* 留痕查不到不影响列表本身 */ })
      .finally(() => {
        for (const id of need) convertLogsBusy.current.delete(id);
      });
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id);
    setDetailNote(null);
    setDetailErr('');
    setDetailTab('summary');
    setDetailLoading(true);
    try {
      const n = await api.getGetnote(id);
      setDetailNote(n);
    } catch (e) {
      setDetailErr(errorText(e, t));
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  const columns = useMemo(
    () =>
      makeColumns(
        setTagQuery,
        openDetail,
        convertLogs,
        configMap,
        configOptions,
        ownerOptions,
        configNameById,
        isAdmin,
      ),
    [openDetail, convertLogs, configMap, configOptions, ownerOptions, configNameById, isAdmin],
  );


  /** 打开「转换」候选弹窗：只列转换配置里 enabled 的模块 */
  const openConvert = useCallback(
    async (row: Record<string, unknown>) => {
      setConvertErr('');
      setConvertWarn('');
      // 归档的笔记不能转换（2026-09-21）。这里挡一道是为了不让人白点一次再到后端吃 409；
      // 真正的闸门在后端留痕接口 —— 列表数据可能是旧的（别人刚把它归档）。
      if (isArchivedNote(row['状态'])) {
        setConvertErr(t('convertArchived'));
        return;
      }
      setConvertRow(row);
      setConvertTargets([]);
      try {
        const cfg = await api.getNoteConvert();
        setConvertTargets((cfg.items ?? []).filter((i) => i.enabled));
      } catch {
        setConvertErr(t('convertLoadFailed'));
      }
    },
    [t],
  );

  /**
   * 执行转换：拉详情取「总结 + 原始记录」→ 写留痕 → 暂存预填 → 跳目标模块。
   *
   * 顺序说明：留痕必须在跳转前做（跳走后就拿不到这篇笔记的上下文了），
   * 所以留痕语义是「已发起转换」，重复转同一模块会累加成 ×2 / ×3。
   *
   * ⚠️ 留痕不写 Get笔记 标签：上游硬限制单篇笔记最多 5 个标签，system + ai
   *    标签常已占掉 4 个，一加就报 `tags length must be less than 5`。
   *    改为记在 ACMS 自己的「笔记转换记录」表，次数可无限累加。
   *    留痕失败只出黄色提示，不阻断转换。
   */
  const doConvert = useCallback(
    async (target: NoteConvertTarget) => {
      const row = convertRow;
      if (!row || convertBusy) return;
      const noteId = String(row.id ?? '');
      if (!noteId) return;
      setConvertBusy(true);
      setConvertErr('');
      setConvertWarn('');
      try {
        const note = (await api.getGetnote(noteId)) as Record<string, unknown>;
        const summary = String(note?.content ?? '');
        const raw = String(note?.rawRecord ?? '');

        // 预填值：目标模块字段名 → 笔记内容。配置项里没填字段名的那一项就跳过。
        const values: Record<string, unknown> = {};
        if (target.summaryField) values[target.summaryField] = summary;
        if (target.rawField) values[target.rawField] = raw;

        /**
         * 原始录音也一起转过去（2026-09-18）。
         *
         * 做法是**把笔记音频的 token 直接写进目标记录的附件字段**，不复制文件：
         * 附件是内容寻址（sha1 前缀）落盘的独立文件，同一 token 被两条记录引用完全安全。
         * 目标模块的附件字段存储结构就是 `[{file_token,name,size,type}]`，
         * 与正文表「音频附件」的结构一致，所以这里能原样搬运。
         *
         * 没配 `audioField` 的目标模块（如纯文本类）就直接不带 —— 不报错、不阻断转换。
         */
        const meta = audioOf(note);
        if (meta && target.audioField) {
          values[target.audioField] = [
            {
              file_token: meta.token,
              name: meta.name ?? `${noteId}.ogg`,
              size: meta.size ?? 0,
              type: meta.type ?? 'audio/ogg',
            },
          ];
        }

        // 留痕：记一条转换记录（同一笔记 + 同一模块累加次数），拿到 logId
        // 供目标页保存成功后回填「转成了哪条记录」。
        let logId = '';
        try {
          const r = await api.logNoteConvert({
            noteId,
            noteTitle: String(note?.title ?? row.title ?? ''),
            moduleKey: target.key,
            moduleLabel: target.label,
          });
          logId = r?.logId ?? '';
          if (r?.count) {
            setConvertLogs((prev) => ({
              ...prev,
              [noteId]: [
                ...(prev[noteId] ?? []).filter((i) => i.moduleKey !== target.key),
                { logId, moduleKey: target.key, moduleLabel: target.label, count: r.count },
              ],
            }));
          }
        } catch (e) {
          /**
           * ⚠️ 归档笔记被后端拦下（409 `NOTE_ARCHIVED`）必须**中断**转换，
           *    不能像普通留痕失败那样只出黄条继续 —— 那样「不可转换」就成了空话。
           *    留痕是转换的必经点，这里中断等于整条转换流程没发生（还没跳转、没写预填）。
           */
          const msg = errorText(e, t);
          if (msg.includes('NOTE_ARCHIVED')) {
            setConvertErr(t('convertArchived'));
            return;
          }
          // 其它留痕失败不阻断转换，但要让用户看见（之前静默吞掉，用户以为成功了）
          setConvertWarn(t('convertLogFailed', { msg }));
        }

        putConvertPayload({
          key: target.key,
          label: target.label,
          href: target.href,
          values,
          noteId,
          noteTitle: String(note?.title ?? row.title ?? ''),
          // 归属人一并发过去：目标模块的「记录人 / 负责人」默认值要用它，
          // 不能用当前登录用户（管理员代转别人的笔记会写成自己）
          noteOwner: String((note as { _owner?: unknown } | null)?._owner ?? row._owner ?? ''),
          // 笔记创建时间：目标模块的「时间」类字段默认取它（毫秒时间戳）
          noteCreatedAt:
            Number((note as { created_at?: unknown } | null)?.created_at ?? row.created_at ?? 0) || undefined,
          logId,
        });
        router.push(`${target.href}?${CONVERT_QUERY_FLAG}=${CONVERT_QUERY_VALUE}`);
      } catch (e) {
        setConvertErr(errorText(e, t));
      } finally {
        setConvertBusy(false);
      }
    },
    [convertRow, convertBusy, router, t],
  );

  // OAuth 设备授权
  const [oauth, setOauth] = useState<GetnoteOAuthStart | null>(null);
  const [oauthFailed, setOauthFailed] = useState<'' | 'expired' | 'rejected'>('');
  const [left, setLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);
  const intervalRef = useRef(5);

  const load = useCallback(() => {
    setLoadErr('');
    api
      .getGetnoteCredential()
      .then(setCred)
      .catch((e: unknown) => {
        const raw = String((e as Error)?.message ?? '');
        // 403 单独提示：这是「没权限」而不是「系统坏了」，用户自己解决不了，必须说清找谁
        setLoadErr(raw.includes('FORBIDDEN') ? t('errNoPermission') : errorText(e, t));
      });
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  /** 组件卸载或弹窗关闭时停掉轮询与倒计时，避免 setState on unmounted */
  useEffect(
    () => () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    },
    [],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const closeOauth = useCallback(() => {
    stopPolling();
    setOauth(null);
    setOauthFailed('');
    setCopied(false);
    void api.cancelGetnoteOAuth().catch(() => undefined);
  }, [stopPolling]);

  /** 单次轮询。用 setTimeout 链而非 setInterval —— 避免上一轮没回来就叠上下一轮。 */
  const pollOnce = useCallback(async () => {
    try {
      const r = await api.pollGetnoteOAuth();
      if (r.status === 'success') {
        stopPolling();
        setOauth(null);
        setOauthFailed('');
        setOk(t('oauthSuccess'));
        load();
        return;
      }
      if (r.status === 'expired') {
        stopPolling();
        setOauthFailed('expired');
        return;
      }
      if (r.status === 'rejected') {
        stopPolling();
        setOauthFailed('rejected');
        return;
      }
      pollRef.current = window.setTimeout(() => void pollOnce(), intervalRef.current * 1000);
    } catch (e) {
      stopPolling();
      setErr(errorText(e, t));
    }
  }, [load, stopPolling, t]);

  const startOauth = async () => {
    setBusy(true);
    setErr('');
    setOk('');
    try {
      const r = await api.startGetnoteOAuth();
      intervalRef.current = r.interval;
      setOauth(r);
      setOauthFailed('');
      setLeft(r.expiresIn);
      pollRef.current = window.setTimeout(() => void pollOnce(), r.interval * 1000);
    } catch (e) {
      setErr(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  /** 倒计时只做展示，过期判定以后端为准（避免前后端时钟不一致导致误判） */
  useEffect(() => {
    if (!oauth || oauthFailed) return;
    const timer = window.setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => window.clearInterval(timer);
  }, [oauth, oauthFailed]);

  const save = async () => {
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await api.saveGetnoteCredential(key.trim(), cid.trim());
      setKey('');
      setCid('');
      setOk(t('keySaved'));
      setOpen(false);
      load();
    } catch (e) {
      setErr(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('confirmRemoveKey'))) return;
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await api.clearGetnoteCredential();
      setOk('');
      setOpen(false);
      load();
    } catch (e) {
      setErr(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!oauth) return;
    try {
      await navigator.clipboard.writeText(oauth.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr(t('copyFailed'));
    }
  };

  /** 手动填入表单。未配置引导页与已配置展开区共用。 */
  const manualForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      {/*
        借道知识库配置时的说明（2026-09-21）：被管理员关联到某条配置的人不需要自己填凭证，
        但必须**告诉他为什么已经能用**，否则他会以为「没配也能用」是巧合、或者去找凭证。
      */}
      {cred?.viaSource && (
        <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: 0, lineHeight: 1.6 }}>
          {t('viaSourceHint', { name: cred.viaSource })}
        </p>
      )}
      <div>
        <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 4px' }}>
          {t('clientIdLabel')}　<span style={{ color: 'var(--fg-tertiary)' }}>{t('clientIdHint')}</span>
        </p>
        <input
          value={cid}
          placeholder="cli_xxx"
          onChange={(e) => setCid(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            fontSize: 13,
          }}
        />
      </div>
      <div>
        <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 4px' }}>
          {t('apiKeyLabel')}　<span style={{ color: 'var(--fg-tertiary)' }}>{t('apiKeyHint')}</span>
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            placeholder="gk_live_xxx"
            onChange={(e) => setKey(e.target.value)}
            style={{
              flex: 1,
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 13,
            }}
          />
          <button type="button" className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? t('hide') : t('show')}
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !key.trim() || !cid.trim()}
          onClick={save}
        >
          {busy ? t('keySaving') : t('testAndSave')}
        </button>
        {cred?.configured && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={remove}
            style={{ color: 'var(--fg-error)' }}
          >
            {t('removeKey')}
          </button>
        )}
        <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{t('saveHint')}</span>
      </div>
    </div>
  );

  /** OAuth 授权区。内联展开而非模态框 —— 扫码要切到手机，遮罩挡着反而碍事。 */
  const oauthPanel = oauth && (
    <div
      style={{
        marginTop: 12,
        padding: 16,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-elevated)',
      }}
    >
      {oauthFailed ? (
        <>
          <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 4px', color: 'var(--fg-error)' }}>
            {oauthFailed === 'expired' ? t('oauthExpired') : t('oauthRejected')}
          </p>
          <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 12px', lineHeight: 1.6 }}>
            {oauthFailed === 'expired' ? t('oauthExpiredDesc') : t('oauthRejectedDesc')}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void startOauth()}
            >
              {t('retryAuth')}
            </button>
            {oauthFailed === 'rejected' && (
              <button type="button" className="btn btn-sm" onClick={closeOauth}>
                {t('useManual')}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={closeOauth}>
              {t('cancel')}
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {oauth.qrcode && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={oauth.qrcode}
              alt={t('scanTip')}
              width={148}
              height={148}
              style={{ borderRadius: 8, border: '1px solid var(--border)', background: '#fff' }}
            />
          )}
          <div style={{ flex: 1, minWidth: 220 }}>
            <p style={{ fontSize: 13, margin: '0 0 12px', color: 'var(--fg-tertiary)', lineHeight: 1.6 }}>
              {t('scanTip')}
            </p>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                border: '1px dashed var(--border)',
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: 14, letterSpacing: 1 }}>
                {oauth.userCode}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void copyCode()}>
                {copied ? t('copied') : t('copy')}
              </button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <a
                href={oauth.verificationUri || OPENAPI_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm"
              >
                {t('openAuthPage')}
              </a>
            </div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                borderRadius: 8,
                background: 'var(--bg-subtle)',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  display: 'inline-block',
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{t('scanning')}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', fontFamily: 'monospace' }}>
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
              </span>
            </div>
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-sm" onClick={closeOauth}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (cred === null) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        {loadErr ? (
          <>
            <p style={{ color: 'var(--fg-error)', fontSize: 13, marginTop: 12, marginBottom: 0 }}>
              {loadErr}
            </p>
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => load()}
            >
              {t('reload')}
            </button>
          </>
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>
            {t('loading')}
          </p>
        )}
      </div>
    );
  }

  // 还没连接：整页引导，不进列表（空列表配一堆报错更让人困惑）
  if (!cred.configured) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        <p className="muted" style={{ marginTop: 12, marginBottom: 20 }}>{t('connectIntro')}</p>

        <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 12px' }}>{t('selfService')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {[
            { n: 1, title: t('step1'), desc: t('step1Desc') },
            { n: 2, title: t('step2'), desc: t('step2Desc') },
            { n: 3, title: t('step3'), desc: t('step3Desc') },
          ].map((s) => (
            <div key={s.n} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span
                style={{
                  flex: '0 0 20px',
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--bg-subtle)',
                  color: 'var(--fg-tertiary)',
                  fontSize: 11,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 1,
                }}
              >
                {s.n}
              </span>
              <div>
                <p style={{ fontSize: 13, margin: 0 }}>{s.title}</p>
                <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '2px 0 0' }}>{s.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <a href={OPENAPI_URL} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
            {t('openOpenApi')}
          </a>
          {cred.oauthEnabled && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void startOauth()}
            >
              {busy ? t('oauthStarting') : t('oauthTitle')}
            </button>
          )}
        </div>

        {oauthPanel}

        {!oauth && (
          <>
            <p style={{ fontSize: 13, fontWeight: 500, margin: '18px 0 0' }}>{t('manualTitle')}</p>
            {manualForm}
          </>
        )}

        {err && (
          <p style={{ color: 'var(--fg-error)', fontSize: 12, marginTop: 12, marginBottom: 0 }}>{err}</p>
        )}
        {ok && (
          <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            {ok}
          </p>
        )}

        <div
          style={{
            marginTop: 18,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: 0, lineHeight: 1.6 }}>
            {t('memberNote')}{' '}
            <a href={CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
              {t('memberLink')}
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {tagQuery && (
        <div
          className="card"
          style={{ padding: '8px 16px', margin: '16px 24px 0', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <span className="muted" style={{ fontSize: 13 }}>
            {t('tagFiltered', { tag: tagQuery })}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setTagQuery('')}>
            {t('clearTagFilter')}
          </button>
        </div>
      )}

      {/*
        归档提示条（2026-09-21）：默认视图只看「有效」，归档的笔记被收起来了。
        没有这条提示的话，管理员归档完会以为笔记丢了 —— 必须让他知道「少了多少、去哪儿看」。
        右侧顺带显示归档/激活的失败原因（成功不加提示：行上的标记与按钮本身就是反馈）。
      */}
      {(archivedHidden > 0 || statusErr) && (
        <div
          className="card"
          style={{ padding: '8px 16px', margin: '16px 24px 0', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          {archivedHidden > 0 && (
            <span className="muted" style={{ fontSize: 13 }}>
              {t('archivedHidden', { n: archivedHidden })}
            </span>
          )}
          {statusErr && (
            <span style={{ fontSize: 13, color: 'var(--danger)' }}>{statusErr}</span>
          )}
        </div>
      )}

      <CrudPage
        moduleKey="getnote"
        // 「保存原始音频」：把笔记的原始录音下载并落进 ACMS（异步任务，label 兼作进度显示）。
        // 只有管理员看得到 —— 这是个消耗上游额度、影响服务器的批量动作。
        extraActions={
          isAdmin
            ? [
                {
                  label: audioJob
                    ? audioJob.running
                      ? `${t('audioSaving')} ${audioJob.done}/${audioJob.total}`
                      : `${t('audioSaved')} ${audioJob.stored}${
                          audioJob.failed ? `（${t('failed')} ${audioJob.failed}）` : ''
                        }`
                    : t('saveAudio'),
                  run: () => startSaveAudio(),
                },
              ]
            : []
        }
        // 检索词变化时整体重挂：强制回到第 1 页重新拉取（否则翻页游标还停在第 N 页）
        key={tagQuery || 'all'}
        title="我的笔记"
        columns={columns}
        pageSize={PAGE_SIZE}
        inlineEdit
        standaloneForm
        search={{ placeholder: t('searchPlaceholder') }}
        enrichEditRow={async (row) => {
          // 列表行只含摘要，rawRecord 仅详情接口返回；编辑前预拉详情回填原始记录
          const n = await api.getGetnote(String(row.id));
          return toRow(n as Record<string, unknown>);
        }}
        // 当前页行变化后批量拉一次留痕，供「已转」列与转换弹窗显示
        onRowsLoaded={onRowsLoaded}
        /**
         * 「操作」列：有录音的笔记直接给「播放 / 停止」按钮，不必再点开详情。
         *
         * 为什么放在操作列而不是加一列：列表列已经很密（标题/类型/标签/已转/更新时间），
         * 而这是**行级动作**，语义上就属于操作列。
         * 音频元信息来自列表接口的 `_audio`（后端批量补，不打上游）。
         */
        rowActionSlot={(row, reload) => {
          const id = String(row.id ?? '');
          const meta = audioOf(row);
          const pendingAudio = audioPendingOf(row);
          const archived = isArchivedNote(row['状态']);
          /**
           * 归档 / 激活（2026-09-21）。
           *
           * 为什么放在**插槽**而不是 `rowExtraActions`：那两个按钮是**互斥**的
           * （同一行只能出现一个），而 rowExtraActions 只支持「静态标签 + 一个动作」、
           * 不能按行换文案/显隐。插槽拿得到行、能自管状态，还能顺带拿到 reload。
           * 权限不足时**整个不渲染** —— 后端同样会拦（接口可直连），前端只是不给死按钮。
           */
          const statusBtn = canSetStatus ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={Boolean(statusBusyId)}
              title={archived ? t('activateTip') : t('archiveTip')}
              // 行上挂着「点击编辑」，不拦住冒泡会顺手打开编辑表单
              onClick={(e) => {
                e.stopPropagation();
                void setNoteStatus(row, archived ? NOTE_STATUS_ACTIVE : NOTE_STATUS_ARCHIVED, reload);
              }}
            >
              {statusBusyId === id
                ? `${archived ? t('activate') : t('archive')}…`
                : archived
                  ? t('activate')
                  : t('archive')}
            </button>
          ) : null;

          // 音频按钮 + 归档/激活：两个都可能为空，都没内容时返回 null（该行操作列不占位）
          const audioBtn = !meta ? (
            // 有录音但音频还没落库：给一个**禁用**的按钮并说明原因。
            // 直接不渲染会让人以为「功能没上线」；灰按钮 + title 能直接指向解法。
            // 判据优先用后端的 `_audioPending`（以「附件数 / 录音卡SN」为准），
            // `note_type` 只作老数据的兜底 —— 见 `audioPendingOf` 的说明。
            pendingAudio || String(row.note_type ?? '') === 'recorder_audio' ? (
              <button type="button" className="btn btn-ghost btn-sm" disabled title={t('noAudioYet')}>
                {pendingAudio ? `⏳ ${t('audioPending')}` : `▶ ${t('play')}`}
              </button>
            ) : null
          ) : (
            (() => {
              const playing = playingId === id;
              const dur = fmtDuration(meta.durationMs);
              return (
                <button
                  type="button"
                  className={playing ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                  title={playing ? t('stopAudio') : `${t('playAudio')}${dur ? ` ${dur}` : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRowAudio(row);
                  }}
                >
                  {playing ? `⏸ ${t('stop')}` : `▶ ${t('play')}`}
                </button>
              );
            })()
          );

          if (!audioBtn && !statusBtn) return null;
          return (
            <>
              {audioBtn}
              {statusBtn}
            </>
          );
        }}
        api={{
          list: async (p) => {
            const src = String(p['来源'] ?? '').trim();
            const cfg = String(p['配置名称'] ?? '').trim();
            const q = tagQuery || p.q;
            // 状态筛选（默认「有效」，见列定义 filterDefault）。判据一律走 contracts 的
            // noteStatusMatches —— 别在这里手写 `=== '有效'`：历史笔记没有状态行，
            // 写等值会把它们全部筛掉（症状是「筛了有效一条都不剩」）。
            const status = String(p['状态'] ?? '').trim();
            /**
             * 来源 / 配置名称 筛选：上游接口没有对应的过滤参数，只能翻页收集后在内存里筛。
             * 所以筛选后一次性返回全部命中项（hasMore=false），不再走游标分页 ——
             * 与语义搜索（q）的返回形态一致，CrudPage 都能正常渲染。
             *
             * ⚠️ 配置名称不在笔记对象里（Get笔记 没有这个字段），要先拿归属映射才能筛。
             * ⚠️ 状态筛选也必须在**这条分支里**再判一次：本分支的数据根本不经过后端筛选
             *    （是前端自己翻页收集的），漏了就会出现「筛了来源之后状态筛选失灵」。
             */
            if (src || cfg) {
              // 命中缓存就直接用，不再翻页收集（切换配置名称时省掉整轮往返）
              const cached = allRowsCacheRef.current;
              let rows: Record<string, unknown>[];
              if (cached && Date.now() - cached.at < ALL_ROWS_CACHE_TTL) {
                rows = cached.rows;
              } else {
                let cursor = '';
                const all: Record<string, unknown>[] = [];
                for (let i = 0; i < SOURCE_FILTER_MAX_PAGES; i++) {
                  // 这里刻意**不带任何筛选**：要的是全量原始行（状态行字段 `_status` 也在其中），
                  // 来源 / 配置名称 / 状态都在下面用内存筛，口径与后端 applyNoteFilters 对齐。
                  const r = await api.listGetnote(cursor ? { pageToken: cursor } : {});
                  all.push(...(r.items ?? []));
                  if (!r.hasMore || !r.pageToken) break;
                  cursor = r.pageToken;
                }
                rows = all.map(toRow);
                allRowsCacheRef.current = { at: Date.now(), rows };
              }
              // 用到配置名称筛选时才查归属；只补「还没查过的」笔记，不整表重拉
              let map: Record<string, NoteConfigMapItem> = configMap;
              if (cfg) {
                const ids = rows.map((r) => String(r.id ?? '')).filter(Boolean);
                const missing = ids.filter((id) => !map[id]);
                if (missing.length) {
                  const extra = await fetchConfigMap(missing);
                  map = { ...map, ...extra };
                  setConfigMap(map);
                }
              }
              const matched = rows.filter((r) => {
                if (src && r['来源'] !== src) return false;
                if (cfg && configDisplayName(map[String(r.id ?? '')], configNameById) !== cfg) {
                  return false;
                }
                return true;
              });
              const items = matched.filter((r) => noteStatusMatches(r['状态'], status));
              // 「已隐藏 N 条**已归档**」在这条分支里自己算（服务端没参与筛选，给不了这个数）。
              // 口径与后端 splitByStatus 共用 `hiddenArchivedCount`：只数「挡掉 ∧ 归档」的，
              // 不能拿 matched.length - items.length（切到「归档」视图时那个差是**有效**笔记的条数）。
              setArchivedHidden(hiddenArchivedCount(matched.map((r) => r['状态']), status));
              return { items, total: items.length, hasMore: false };
            }
            const res = await api.listGetnote({ ...p, ...(q ? { q } : {}) });
            setArchivedHidden(Number(res.archivedHidden ?? 0) || 0);
            // ?? [] 是防御：上游偶发不返回数组时，CrudPage 内部 res.items.length 也会崩
            return { ...res, items: (res.items ?? []).map(toRow) };
          },
        create: (d) => api.createGetnote(toPayload(d)),
        update: (id, d) => api.updateGetnote(id, toPayload(d)),
        // 删除 = 移入回收站，可恢复
        archive: (id) => api.deleteGetnote(id),
      }}
      rowExtraActions={[
        {
          label: t('convert'),
          run: (row) => openConvert(row),
        },
      ]}
    />

      {detailId && (
        <div style={detailOverlay} onClick={() => setDetailId('')}>
          <div style={detailModal} onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700 }}>{t('noteDetail')}</h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setDetailId('')}
                title={tl('关闭')}
                aria-label={tl('关闭')}
              >
                ×
              </button>
            </div>
            {detailErr && (
              <p style={{ color: 'var(--fg-error)', fontSize: 13, marginTop: 0, marginBottom: 8 }}>
                {detailErr}
              </p>
            )}
            {detailLoading && <p className="muted" style={{ fontSize: 13 }}>{t('loading')}</p>}
            {detailNote && (
              <div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 16,
                    fontSize: 12,
                    color: 'var(--fg-tertiary)',
                    marginBottom: 12,
                  }}
                >
                  <span>来源：{tagNames(detailNote).find((x) => NOTE_TYPES.includes(x)) ?? '得到大脑'}</span>
                  <span>
                    标签：{tagNames(detailNote).filter((x) => !NOTE_TYPES.includes(x)).join('、') || '—'}
                  </span>
                  <span>更新时间：{String(detailNote.updated_at ?? '')}</span>
                </div>

                {/* 原始音频（2026-09-17 起可落库）。只在真下载过时出现；
                    播放走 /getnote/notes/:id/audio —— 该接口带笔记级可见性校验 */}
                {audioOf(detailNote) ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginBottom: 12,
                      padding: '8px 12px',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                    }}
                  >
                    <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                      🎧 {t('audio')}
                      {fmtDuration(audioOf(detailNote)?.durationMs)
                        ? ` ${fmtDuration(audioOf(detailNote)?.durationMs)}`
                        : ''}
                    </span>
                    <audio
                      controls
                      preload="none"
                      style={{ flex: 1, height: 32 }}
                      src={audioSrc(String(detailNote.id ?? detailId))}
                    />
                  </div>
                ) : audioPendingOf(detailNote) ? (
                  /**
                   * 有录音、但音频还没抓下来（2026-09-22 补）。
                   * 原先这里**什么都不渲染** —— 详情页看起来就是一篇普通笔记，
                   * 谁也不会想到「这篇的录音躺在上游没搬过来」。
                   */
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginBottom: 12,
                      padding: '8px 12px',
                      border: '1px dashed var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'var(--fg-tertiary)',
                    }}
                  >
                    ⏳ {t('noAudioYet')}
                  </div>
                ) : null}

                {/* 总结 / 原始记录 两个 Tab */}
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    marginBottom: 12,
                    borderBottom: '1px solid var(--border)',
                    paddingBottom: 8,
                  }}
                >
                  <button
                    type="button"
                    className={detailTab === 'summary' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                    onClick={() => setDetailTab('summary')}
                  >
                    {t('summary')}
                  </button>
                  <button
                    type="button"
                    className={detailTab === 'raw' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                    onClick={() => setDetailTab('raw')}
                  >
                    {t('rawRecord')}
                  </button>
                </div>

                {detailTab === 'summary' ? (
                  <div
                    className="md"
                    style={{
                      maxHeight: '60vh',
                      overflow: 'auto',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '12px 16px',
                      background: 'var(--bg-subtle)',
                    }}
                  >
                    <Markdown>{String((detailNote.content as string) ?? '')}</Markdown>
                  </div>
                ) : (
                  <div
                    style={{
                      maxHeight: '60vh',
                      overflow: 'auto',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '12px 16px',
                      background: 'var(--bg-subtle)',
                    }}
                  >
                    {String((detailNote.rawRecord as string) ?? '').trim() ? (
                      <pre
                        style={{
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: 13,
                          lineHeight: 1.7,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                          color: 'var(--fg)',
                        }}
                      >
                        {String(detailNote.rawRecord as string)}
                      </pre>
                    ) : (
                      <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('noRawRecord')}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 「转换」候选模块弹窗：只列转换配置里 enabled 的菜单 */}
      {convertRow && (
        <div
          style={detailOverlay as React.CSSProperties}
          onClick={() => { if (!convertBusy) { setConvertRow(null); setConvertErr(''); setConvertWarn(''); } }}
        >
          <div style={convertModal as React.CSSProperties} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700 }}>
                  {t('convertTitle')}
                </h3>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--fg-tertiary)', lineHeight: 1.6 }}>
                  {t('convertTip', { title: String(convertRow.title ?? '') })}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={convertBusy}
                onClick={() => { setConvertRow(null); setConvertErr(''); setConvertWarn(''); }}
              >
                ×
              </button>
            </div>

            {convertErr && <p className="msg-error" style={{ marginTop: 0 }}>{convertErr}</p>}

            {/* 留痕写不进去时的黄色提示：转换照常继续，但必须让用户看见 */}
            {convertWarn && (
              <p
                style={{
                  marginTop: 0,
                  marginBottom: 10,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.6,
                  background: '#FAEEDA',
                  border: '1px solid #EF9F27',
                  color: '#854F0B',
                }}
              >
                {convertWarn}
              </p>
            )}

            {convertTargets.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, margin: '4px 0 0', lineHeight: 1.7 }}>
                {t('convertNoTarget')}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {convertTargets.map((tg) => {
                  // 这篇笔记转过该模块几次（留痕来自 ACMS 转换记录表，不是 Get笔记 标签）
                  const done = (convertLogs[String(convertRow?.id ?? '')] ?? []).find(
                    (i) => i.moduleKey === tg.key,
                  );
                  return (
                    <button
                      key={tg.key}
                      type="button"
                      disabled={convertBusy}
                      onClick={() => void doConvert(tg)}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 4,
                        padding: '10px 12px',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--bg-subtle)',
                        cursor: convertBusy ? 'default' : 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)' }}>
                        {tg.label}
                        {tg.enLabel ? (
                          <span style={{ fontWeight: 400, color: 'var(--fg-tertiary)', marginLeft: 6 }}>
                            {tg.enLabel}
                          </span>
                        ) : null}
                        {done?.count ? (
                          <span
                            title={t('convertedTimesTip', { label: tg.label, count: done.count })}
                            style={{
                              fontWeight: 400,
                              fontSize: 11,
                              marginLeft: 8,
                              padding: '1px 8px',
                              borderRadius: 999,
                              background: 'var(--bg-elevated)',
                              border: '1px solid var(--border)',
                              color: 'var(--fg-tertiary)',
                            }}
                          >
                            {t('convertedTimes', { count: done.count })}
                          </span>
                        ) : null}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>
                        {t('convertFieldMap', {
                          summary: tg.summaryField || '—',
                          raw: tg.rawField || '—',
                        })}
                        {/* 让人一眼看出「这次转换会不会带上录音」—— 有音频但目标模块没配
                            audioField 时什么都不显示，用户自然会去「转换配置」里补字段 */}
                        {audioOf(convertRow) && tg.audioField ? (
                          <span style={{ marginLeft: 8, color: 'var(--accent)' }}>
                            🎧 {t('audioWithConvert')}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={convertBusy}
                onClick={() => { setConvertRow(null); setConvertErr(''); setConvertWarn(''); }}
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

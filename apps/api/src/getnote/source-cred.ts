import type { BaseClient } from '@acms/base-adapter';
import { toText } from '@acms/base-adapter';
import { decryptSecret } from '../ai/lib/crypto/kms.js';
// 关联/多值字段的宽容解析器与邮件归档共用一份（数组 / {link_record_ids} / JSON 字符串三种形态）
import { idsOf } from '../mail-archive/mail-archive.meta.js';

/**
 * 「知识库配置」表的读取工具 —— 故意做成**无 Nest 依赖的纯函数模块**。
 *
 * ⚠️ 为什么不放在 SourcesService 里：
 *   sources.service.ts 已经 import 了 GetnoteService；而管理员聚合笔记时，
 *   GetnoteService 又需要「列出所有启用配置 + 解出凭证」的能力。
 *   若 GetnoteService 反向 import SourcesService 就构成**循环依赖**（Nest 会报
 *   "Nest can't resolve dependencies"，或者直接拿到 undefined 实例）。
 *   所以把这块只读能力下沉到这里，两边都引它，依赖图保持单向。
 */

/** 「启用状态」字段：除了显式「停用」都算启用 */
export function isEnabledStatus(v: unknown): boolean {
  return String(v ?? '').trim() !== '停用';
}

/** 飞书文本字段可能返回 string 或 [{text}]，统一取纯文本 */
export function plainText(v: unknown): string {
  return toText(v) ?? '';
}

/**
 * 解出配置行的凭证。配置表的「凭证」字段存的是
 * `JSON.stringify(encryptSecret(JSON.stringify({apiKey, clientId})))`。
 *
 * ⚠️ 为什么这么绕：飞书文本字段**不能存对象**（直接存会 1254060 TextFieldConvFail），
 * 而 KMS 信封本身又是对象 —— 所以信封先 stringify 成一层 JSON 字符串才能落库，
 * 读回时先 parse 成信封对象再 decryptSecret。
 */
export function decodeSourceCred(enc: unknown): Record<string, string> {
  if (!enc) return {};
  try {
    const envelope = typeof enc === 'string' ? JSON.parse(enc) : enc;
    const plain = String(decryptSecret(envelope) ?? '');
    if (!plain) return {};
    const obj = JSON.parse(plain);
    return obj && typeof obj === 'object' ? (obj as Record<string, string>) : {};
  } catch {
    // 主密钥轮换或数据损坏时解密会抛。当作「未配置」，不阻断整个列表。
    return {};
  }
}

export interface SourceCredEntry {
  recordId: string;
  sourceName: string;
  sourceType: string;
  /** 配置归属人 openId（可能为空 —— 加归属字段之前的存量数据） */
  ownerOpenId: string;
  ownerName: string;
  /** 「关联用户」里存的是**用户表 record id**（与邮件账户同一范式），可为空（存量数据） */
  linkedUserIds: string[];
  /** 解不出有效凭证时为 null（调用方跳过即可） */
  cred: { key: string; clientId: string } | null;
}

/**
 * 用 openId 反查「用户表」里的 record id。
 *
 * ⚠️ 为什么需要它：`关联用户`（与邮件账户同一范式）存的是**用户 record id**，
 * 而 `归属人ID` 存的是 **openId** —— 两者不是同一个东西，不能直接比较。
 * 判「我关不关联到这条配置」时必须先把自己的 record id 解出来。
 *
 * 结果做进程内缓存（openId → recordId 基本不变），避免每次列表都全表搜一遍用户表。
 */
const userIdCache = new Map<string, string>();

export async function resolveUserIdByOpenId(
  base: BaseClient,
  userTableId: string,
  openId: string,
): Promise<string> {
  const key = String(openId ?? '').trim();
  if (!key) return '';
  const hit = userIdCache.get(key);
  if (hit !== undefined) return hit;
  let found = '';
  try {
    let token: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await base.search(userTableId, { pageSize: 200, pageToken: token });
      for (const r of res.items) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        if (plainText(f['飞书 Open ID']) === key) {
          found = String(r.recordId ?? '');
          break;
        }
      }
      if (found || !res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
  } catch {
    // 用户表读不到就当没关联（宁可少看不可多看）
  }
  userIdCache.set(key, found);
  return found;
}

/**
 * 🔴 「这个用户能不能看到这条知识库配置」——**唯一判据**。
 *
 * 列表、详情、编辑鉴权、以及笔记列表的收窄，全部必须调这一个函数。
 * 判据写两处必然漂移（一处放行、一处拦截，就是越权或"看不到自己的东西"）。
 *
 * 规则：
 *  - 系统管理员：全可见（豁免）
 *  - 否则：`关联用户` 里包含我（多用户关联，2026-09-17 新增），
 *    **或** `归属人ID` === 我（单人归属，2026-09-07 的存量语义，保留以兼容历史数据）
 *
 * ⚠️ 比较用的是 **openId / 用户 record id**，不用姓名 —— 姓名会重名，拿姓名判权限必出事。
 */
export function sourceVisibleTo(
  entry: Pick<SourceCredEntry, 'ownerOpenId' | 'linkedUserIds'>,
  user: { openId?: string; roles?: readonly string[] } | null | undefined,
  myUserId: string,
  bypassRoles: readonly string[] = ['系统管理员'],
): boolean {
  if ((user?.roles ?? []).some((r) => bypassRoles.includes(r))) return true;
  const openId = String(user?.openId ?? '').trim();
  if (myUserId && entry.linkedUserIds.includes(myUserId)) return true;
  return Boolean(openId) && entry.ownerOpenId === openId;
}

/**
 * 🔴 「这条笔记属不属于**我可见的那些源**」——非管理员列表（`listScopedBySources`）的唯一判据。
 *
 * 规则：`_sourceRecordId` 命中我的可见配置集合，**或者**它为空字符串。
 *
 * ⚠️ 为什么空串必须放行：空串是 `collectAllNotes` 里**「本人凭证」那一路**的标记
 *   （那一路刻意不带 recordId，见其 push 处的注释）。它只包含**调用者自己**凭证拉来的
 *   笔记，放行不存在越权；反过来若把空串一律丢弃，就会踩一个极难查的坑 ——
 *
 *   > 在向导页填过**个人凭证**、同时又有关联的知识库配置的用户：
 *   > 个人凭证源先入列并占住 `seenKey`（按 API Key 去重）⇒ 同一份 Key 的配置源被跳过
 *   > ⇒ 他的笔记全部挂在空 recordId 上 ⇒ 白名单一个都不命中 ⇒ **「我的笔记」恒为空**。
 *   > 而管理员完全正常（管理员的凭证 Key 与他不同，他的配置源不会被跳过、recordId 是对的）
 *   > ⇒ 症状表现为「这个人自己看不到，管理员却看得到」。
 *   > 2026-09-17 刘佳音｜Joy 报障（15 条一条不显示）即此因。
 *
 * ⚠️ 别把这里改成「空串视为可见配置」之类的白名单补集 —— 判据只做 OR，不做集合推导。
 */
export function noteInScopedSources(
  note: { _sourceRecordId?: string },
  sourceIds: readonly string[],
): boolean {
  const rid = String(note?._sourceRecordId ?? '');
  if (rid === '') return true;
  return sourceIds.includes(rid);
}

/**
 * 列出**所有启用**的知识库配置及其解好的凭证。
 *
 * ⚠️ 刻意**不做任何按人过滤**：这个方法服务的都是"系统级"调用方 ——
 *   ① 管理员聚合所有人的笔记；② 后台 cron 同步。若在这里加归属过滤，
 *   后台就永远同步不到别人的配置了。行级隔离由 `sourceVisibleTo` 在 HTTP 入口层做。
 */
export async function listEnabledSourceCreds(
  base: BaseClient,
  tableId: string,
  opts: { maxPages?: number } = {},
): Promise<SourceCredEntry[]> {
  const maxPages = Math.min(Math.max(Number(opts.maxPages) || 5, 1), 20);
  const out: SourceCredEntry[] = [];
  let pageToken: string | undefined;

  for (let i = 0; i < maxPages; i++) {
    const res = await base.search(tableId, { pageSize: 200, pageToken });
    for (const r of res.items) {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      if (!isEnabledStatus(f['启用状态'])) continue;

      const cred = decodeSourceCred(f['凭证']);
      const apiKey = String(cred.apiKey ?? cred.api_key ?? '').trim();
      const clientId = String(cred.clientId ?? cred.client_id ?? '').trim();

      out.push({
        recordId: r.recordId,
        sourceName: plainText(f['配置名称']) || r.recordId,
        sourceType: plainText(f['笔记类型']),
        ownerOpenId: plainText(f['归属人ID']),
        ownerName: plainText(f['归属人']),
        // 宽容解析：关联字段可能返回 string[] / {link_record_ids:[...]} / JSON 字符串
        linkedUserIds: idsOf(f['关联用户']),
        cred: apiKey && clientId ? { key: apiKey, clientId } : null,
      });
    }
    if (!res.hasMore || !res.pageToken) break;
    pageToken = res.pageToken;
  }
  return out;
}

import type { BaseClient } from '@acms/base-adapter';
import { toText } from '@acms/base-adapter';
import { decryptSecret } from '../ai/lib/crypto/kms.js';

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
  /** 解不出有效凭证时为 null（调用方跳过即可） */
  cred: { key: string; clientId: string } | null;
}

/**
 * 列出**所有启用**的知识库配置及其解好的凭证。
 *
 * ⚠️ 刻意**不做任何按人过滤**：这个方法服务的都是"系统级"调用方 ——
 *   ① 管理员聚合所有人的笔记；② 后台 cron 同步。若在这里加归属过滤，
 *   后台就永远同步不到别人的配置了。行级隔离由 HTTP 入口层（SourcesService.list）负责。
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
        cred: apiKey && clientId ? { key: apiKey, clientId } : null,
      });
    }
    if (!res.hasMore || !res.pageToken) break;
    pageToken = res.pageToken;
  }
  return out;
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { BaseClient, toText } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { REDIS } from '../redis.provider.js';
import { BASE_CLIENT } from '../base.provider.js';
import { SessionService } from '../auth/session.service.js';
import { buildFilter } from '../shared/record.util.js';

const BINDING_TABLE = TABLES.wechatBinding.tableId;
/** 小程序绑定在 redis 的键前缀（与 MiniProgramService.bind 保持一致） */
const WXBIND_PREFIX = 'wxbind:';

export interface UpsertBindingInput {
  /** 微信 openid（小程序）或 parent_<studentId>（家长 H5），作为唯一标识 */
  openId: string;
  studentId?: string;
  studentNo?: string;
  name?: string;
  role: 'student' | 'parent';
  loginMethod: '微信小程序' | '家长H5' | '学生网页';
}

/**
 * 微信登录用户（绑定记录）服务。
 *  - upsertBinding：登录成功时写入/更新一条绑定记录（供后台查看与解绑/强制下线）。
 *  - unbind：移除 redis 绑定键 + 强制下线 + 标记记录为「已解绑」（保留历史）。
 *  - forceLogout：仅销毁该身份当前会话（保留绑定）。
 */
@Injectable()
export class WechatBindingService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly sessions: SessionService,
  ) {}

  /** 登录时 upsert 一条绑定记录 */
  async upsertBinding(input: UpsertBindingInput): Promise<void> {
    const now = new Date().toISOString();
    const res = await this.base.search(BINDING_TABLE, {
      pageSize: 10,
      filter: buildFilter([{ field: '标识', value: [input.openId] }]),
    });
    const existing = res.items[0];
    const fields: Record<string, unknown> = {
      角色: input.role,
      登录方式: input.loginMethod,
      状态: '已绑定',
      最近登录: now,
    };
    if (input.studentId) fields['关联学生'] = input.name ?? '';
    if (input.studentNo) fields['学号'] = input.studentNo;
    if (input.name) fields['姓名'] = input.name;

    if (existing) {
      await this.base.update(BINDING_TABLE, existing.recordId, fields);
    } else {
      fields['标识'] = input.openId;
      fields['绑定时间'] = now;
      if (input.studentId) fields['关联学生'] = input.name ?? '';
      await this.base.create(BINDING_TABLE, fields);
    }
  }

  /** 解绑：移除 redis 绑定键 + 强制下线 + 标记记录为已解绑 */
  async unbind(id: string): Promise<{ ok: boolean }> {
    const rec = await this.base.get(BINDING_TABLE, id);
    if (!rec) throw new NotFoundException('BINDING_NOT_FOUND');
    const openId = toText(rec.fields['标识']) ?? '';
    // 小程序绑定键；家长无此键，删除无害
    await this.redis.del(WXBIND_PREFIX + openId);
    // 强制下线当前会话（如有）
    await this.sessions.destroyByOpenid(openId);
    await this.base.update(BINDING_TABLE, id, { 状态: '已解绑' });
    return { ok: true };
  }

  /** 强制下线：仅销毁当前会话，保留绑定 */
  async forceLogout(id: string): Promise<{ ok: boolean }> {
    const rec = await this.base.get(BINDING_TABLE, id);
    if (!rec) throw new NotFoundException('BINDING_NOT_FOUND');
    const openId = toText(rec.fields['标识']) ?? '';
    await this.sessions.destroyByOpenid(openId);
    return { ok: true };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { BaseClient, toText } from '@acms/base-adapter';
import {
  TABLES,
  DEFAULT_HOMEPAGE_CONFIG,
  DEFAULT_NAV_MENU_CONFIG,
  type HomepageConfig,
  type NavMenuConfig,
} from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';

const TABLE_ID = TABLES.systemConfig.tableId;
const CONFIG_KEY = 'homepage_config';
const MENU_CONFIG_KEY = 'nav_menu_config';

@Injectable()
export class HomepageConfigService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /** 读取主页配置；未配置时返回默认配置 */
  async get(): Promise<HomepageConfig> {
    const rec = await this.findRecord(CONFIG_KEY);
    if (!rec) return DEFAULT_HOMEPAGE_CONFIG;
    const raw = toText(rec.fields['配置值']);
    if (!raw) return DEFAULT_HOMEPAGE_CONFIG;
    try {
      const parsed = JSON.parse(raw) as Partial<HomepageConfig>;
      return { ...DEFAULT_HOMEPAGE_CONFIG, ...parsed };
    } catch {
      return DEFAULT_HOMEPAGE_CONFIG;
    }
  }

  /** 保存主页配置（配置键=homepage_config，不存在则新建） */
  async save(dto: HomepageConfig): Promise<{ ok: boolean }> {
    const value = JSON.stringify(dto);
    const rec = await this.findRecord(CONFIG_KEY);
    if (rec) {
      await this.base.update(TABLE_ID, rec.recordId, {
        '配置值': value,
        '状态': '启用',
      } as Record<string, unknown>);
    } else {
      await this.base.create(TABLE_ID, {
        '配置键': CONFIG_KEY,
        '配置值': value,
        '分组': '界面配置',
        '说明': '登录页/主页配置（JSON）',
        '状态': '启用',
      } as Record<string, unknown>);
    }
    return { ok: true };
  }

  /** 读取导航菜单配置 */
  async getMenu(): Promise<NavMenuConfig> {
    const rec = await this.findRecord(MENU_CONFIG_KEY);
    if (!rec) return DEFAULT_NAV_MENU_CONFIG;
    const raw = toText(rec.fields['配置值']);
    if (!raw) return DEFAULT_NAV_MENU_CONFIG;
    try {
      const parsed = JSON.parse(raw) as Partial<NavMenuConfig>;
      if (Array.isArray(parsed.items)) return parsed as NavMenuConfig;
      return DEFAULT_NAV_MENU_CONFIG;
    } catch {
      return DEFAULT_NAV_MENU_CONFIG;
    }
  }

  /** 保存导航菜单配置 */
  async saveMenu(dto: NavMenuConfig): Promise<{ ok: boolean }> {
    const value = JSON.stringify(dto);
    const rec = await this.findRecord(MENU_CONFIG_KEY);
    if (rec) {
      await this.base.update(TABLE_ID, rec.recordId, {
        '配置值': value,
        '状态': '启用',
      } as Record<string, unknown>);
    } else {
      await this.base.create(TABLE_ID, {
        '配置键': MENU_CONFIG_KEY,
        '配置值': value,
        '分组': '界面配置',
        '说明': '导航菜单配置（JSON）',
        '状态': '启用',
      } as Record<string, unknown>);
    }
    return { ok: true };
  }

  private async findRecord(configKey: string) {
    const res = await this.base.search(TABLE_ID, {
      pageSize: 10,
      filter: buildFilter([{ field: '配置键', value: [configKey] }]),
    });
    return res.items[0];
  }
}

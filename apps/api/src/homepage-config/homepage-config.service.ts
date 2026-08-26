import { Inject, Injectable } from '@nestjs/common';
import { BaseClient, toText } from '@acms/base-adapter';
import {
  TABLES,
  DEFAULT_HOMEPAGE_CONFIG,
  DEFAULT_NAV_MENU_CONFIG,
  type HomepageConfig,
  type NavMenuConfig,
  type NavMenuGroupConfig,
  type NavMenuGroup,
} from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';

const TABLE_ID = TABLES.systemConfig.tableId;
const CONFIG_KEY = 'homepage_config';
const MENU_CONFIG_KEY = 'nav_menu_config';
const MENU_GROUPS_KEY = 'nav_menu_groups';

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

  /** 读取导航菜单配置；将默认系统菜单中缺失的项自动补充进去 */
  async getMenu(): Promise<NavMenuConfig> {
    const rec = await this.findRecord(MENU_CONFIG_KEY);
    let stored: NavMenuConfig = { items: [] };
    if (rec) {
      const raw = toText(rec.fields['配置值']);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<NavMenuConfig>;
          if (Array.isArray(parsed.items)) stored = parsed as NavMenuConfig;
        } catch { /* ignore */ }
      }
    }
    const storedKeys = new Set(stored.items.map((it) => it.key));
    const mergedItems = [
      ...stored.items,
      ...DEFAULT_NAV_MENU_CONFIG.items.filter((it) => !storedKeys.has(it.key)),
    ];
    return { items: mergedItems };
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

  /** 默认菜单分组（由默认导航菜单的 section 去重得出，保持稳定 key=label） */
  private defaultMenuGroups(): NavMenuGroup[] {
    const seen = new Set<string>();
    const items: NavMenuGroup[] = [];
    let order = 10;
    for (const it of DEFAULT_NAV_MENU_CONFIG.items) {
      const section = it.section;
      if (!section) continue;
      if (!seen.has(section)) {
        seen.add(section);
        items.push({ key: section, label: section, order });
        order += 10;
      }
    }
    return items;
  }

  /** 读取菜单分组配置；将默认分组中缺失的项自动补充进去 */
  async getMenuGroups(): Promise<NavMenuGroupConfig> {
    const rec = await this.findRecord(MENU_GROUPS_KEY);
    let stored: NavMenuGroupConfig = { items: [] };
    if (rec) {
      const raw = toText(rec.fields['配置值']);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<NavMenuGroupConfig>;
          if (Array.isArray(parsed.items)) stored = parsed as NavMenuGroupConfig;
        } catch { /* ignore */ }
      }
    }
    const storedKeys = new Set(stored.items.map((g) => g.key));
    const merged: NavMenuGroup[] = [
      ...stored.items,
      ...this.defaultMenuGroups().filter((g) => !storedKeys.has(g.key)),
    ];
    return { items: merged };
  }

  /** 保存菜单分组配置 */
  async saveMenuGroups(dto: NavMenuGroupConfig): Promise<{ ok: boolean }> {
    const value = JSON.stringify(dto);
    const rec = await this.findRecord(MENU_GROUPS_KEY);
    if (rec) {
      await this.base.update(TABLE_ID, rec.recordId, {
        '配置值': value,
        '状态': '启用',
      } as Record<string, unknown>);
    } else {
      await this.base.create(TABLE_ID, {
        '配置键': MENU_GROUPS_KEY,
        '配置值': value,
        '分组': '界面配置',
        '说明': '导航菜单分组配置（JSON）',
        '状态': '启用',
      } as Record<string, unknown>);
    }
    return { ok: true };
  }

  /** 列出记录（供 Controller 取 bitablePerm 上下文用） */
  async listRecords(tableId: string, pageSize: number) {
    const res = await this.base.search(tableId, { pageSize });
    return res.items;
  }

  /** 列出字段（供 Controller 取 bitablePerm 上下文用） */
  async listFields(tableId: string) {
    return this.base.listFields(tableId);
  }
}

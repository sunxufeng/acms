import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { BaseClient, toText } from '@acms/base-adapter';
import {
  TABLES,
  DEFAULT_HOMEPAGE_CONFIG,
  DEFAULT_NAV_MENU_CONFIG,
  DEFAULT_CONVERT_FIELDS,
  SECTION_EN_LABELS,
  type HomepageConfig,
  type NavMenuConfig,
  type NavMenuGroupConfig,
  type NavMenuGroup,
  type NoteConvertConfig,
  type NoteConvertTarget,
} from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';

const TABLE_ID = TABLES.systemConfig.tableId;
const CONFIG_KEY = 'homepage_config';
const MENU_CONFIG_KEY = 'nav_menu_config';
const MENU_GROUPS_KEY = 'nav_menu_groups';
const NOTE_CONVERT_KEY = 'note_convert_config';

@Injectable()
export class HomepageConfigService implements OnModuleInit {
  private readonly logger = new Logger('HomepageConfigService');

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly fileUpload: FileUploadService,
  ) {}

  /** 启动时预缓存 homepage_config 中的所有图片 file_token */
  async onModuleInit(): Promise<void> {
    try {
      const config = await this.getRawConfig();
      if (config) {
        const result = await this.fileUpload.precacheConfigImages(config);
        if (result.cached > 0) {
          this.logger.log(`启动预缓存: ${result.cached} 个图片 URL 已缓存${result.failed > 0 ? `, ${result.failed} 个失败` : ''}`);
        }
      }
    } catch (e) {
      this.logger.warn(`启动预缓存跳过（非致命）: ${(e as Error).message}`);
    }
  }

  private async getRawConfig(): Promise<string | null> {
    const rec = await this.findRecord(CONFIG_KEY);
    return rec ? (toText(rec.fields['配置值']) ?? null) : null;
  }

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
    // 自愈：enLabel 缺失时从默认配置兜底（存储有则优先）；
    // perm / adminOnly 是**管控属性**，一律以代码默认配置为准（不受存储旧值影响）。
    // 原因：早期存储的菜单项没有 perm 字段，导致这些菜单对所有登录用户可见、无法按角色授权；
    // 而若只在 perm 缺失时补齐，代码里后续拆分/调整权限点（如 学生观察 student:read → observation:read）
    // 时存量存储的旧值不会更新，新权限点形同虚设。展示类属性（label/href/order/section/icon）仍尊重存储。
    const defaultByKey = new Map(DEFAULT_NAV_MENU_CONFIG.items.map((it) => [it.key, it]));
    for (const it of mergedItems) {
      const def = defaultByKey.get(it.key);
      if (!def) continue;
      if (!it.enLabel && def.enLabel) it.enLabel = def.enLabel;
      if (def.perm !== undefined) it.perm = def.perm;
      else delete it.perm;
      if (def.adminOnly !== undefined) it.adminOnly = def.adminOnly;
      else delete it.adminOnly;
    }
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
        items.push({ key: section, label: section, enLabel: SECTION_EN_LABELS[section], order });
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
    // 自愈：存储中缺失 enLabel 的分组，从 SECTION_EN_LABELS 兜底补齐（存储有则优先）。
    for (const g of merged) {
      if (!g.enLabel) {
        const fallback = SECTION_EN_LABELS[g.key] ?? SECTION_EN_LABELS[g.label];
        if (fallback) g.enLabel = fallback;
      }
    }
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

  /**
   * 读取「笔记 → 业务记录」转换配置。
   *
   * 自愈策略（与菜单配置同款）：默认导航菜单里出现的新功能会**自动补进列表**
   * （enabled 默认 false、字段取 DEFAULT_CONVERT_FIELDS 的智能默认），
   * 所以系统新开发的模块无需手工登记就会出现在配置页；
   * 已存储项的路径/英文名若与菜单不一致，以菜单为准同步刷新。
   */
  async getNoteConvert(): Promise<NoteConvertConfig> {
    const rec = await this.findRecord(NOTE_CONVERT_KEY);
    let stored: NoteConvertConfig = { items: [] };
    if (rec) {
      const raw = toText(rec.fields['配置值']);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<NoteConvertConfig>;
          if (Array.isArray(parsed.items)) stored = parsed as NoteConvertConfig;
        } catch { /* ignore */ }
      }
    }

    const menuByKey = new Map(DEFAULT_NAV_MENU_CONFIG.items.map((it) => [it.key, it]));
    const storedKeys = new Set(stored.items.map((i) => i.key));

    // 已存储项：同步菜单上已改动的中文名/英文名/路径（用户可改的 enabled 与字段不动）
    const kept: NoteConvertTarget[] = stored.items.map((it) => {
      const m = menuByKey.get(it.key);
      if (!m) return it; // 手工新增项，没有对应菜单
      return {
        ...it,
        label: m.label,
        enLabel: m.enLabel ?? it.enLabel,
        href: m.href,
        summaryField: it.summaryField || DEFAULT_CONVERT_FIELDS[it.key]?.summaryField || '',
        rawField: it.rawField || DEFAULT_CONVERT_FIELDS[it.key]?.rawField || '',
      };
    });

    // 自愈补充：菜单里有、配置里没有的新功能（disabled 的「敬请期待」项跳过）
    const added: NoteConvertTarget[] = DEFAULT_NAV_MENU_CONFIG.items
      .filter((m) => !storedKeys.has(m.key) && !m.disabled)
      .map((m, idx) => ({
        key: m.key,
        label: m.label,
        enLabel: m.enLabel,
        href: m.href,
        enabled: false,
        summaryField: DEFAULT_CONVERT_FIELDS[m.key]?.summaryField ?? '',
        rawField: DEFAULT_CONVERT_FIELDS[m.key]?.rawField ?? '',
        order: 1000 + idx,
      }));

    return { items: [...kept, ...added] };
  }

  /** 保存笔记转换配置 */
  async saveNoteConvert(dto: NoteConvertConfig): Promise<{ ok: boolean }> {
    const value = JSON.stringify(dto);
    const rec = await this.findRecord(NOTE_CONVERT_KEY);
    if (rec) {
      await this.base.update(TABLE_ID, rec.recordId, {
        '配置值': value,
        '状态': '启用',
      } as Record<string, unknown>);
    } else {
      await this.base.create(TABLE_ID, {
        '配置键': NOTE_CONVERT_KEY,
        '配置值': value,
        '分组': '界面配置',
        '说明': '笔记转换配置（JSON）',
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

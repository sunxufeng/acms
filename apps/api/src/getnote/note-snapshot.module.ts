import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { ensureNoteStatusTable } from './note-status.schema.js';

/**
 * 笔记相关自建表的启动期建表服务。
 *
 * 与部门表 / 会议纪要表同路径（ACMS 自建 SQL 表，不走飞书 Base），
 * 必须在启动期幂等建表，否则首次写入会因表不存在而失败。
 * 目前管两张：**笔记快照表**（报表数据源）与**笔记状态表**（有效 / 归档）。
 */
@Injectable()
export class NoteSnapshotSchemaService {
  async ensure(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      console.warn('[note-snapshot] 未配置 DATABASE_URL，跳过建表');
      return;
    }
    await sql.ensureTable(TABLES.noteSnapshot.tableId, '笔记快照表', []);
    console.log('[note-snapshot] 笔记快照表已就绪');
    // 笔记状态表的字段元数据在 note-status.schema.ts（与服务内懒建共用同一份）
    await ensureNoteStatusTable();
    console.log('[note-snapshot] 笔记状态表已就绪');
  }
}

@Module({
  providers: [NoteSnapshotSchemaService],
  exports: [NoteSnapshotSchemaService],
})
export class NoteSnapshotModule implements OnModuleInit {
  constructor(private readonly svc: NoteSnapshotSchemaService) {}
  async onModuleInit() {
    try {
      await this.svc.ensure();
    } catch (e) {
      console.error(`[note-snapshot] 启动建表失败: ${(e as Error).message}`);
    }
  }
}

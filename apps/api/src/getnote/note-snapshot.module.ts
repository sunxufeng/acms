import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';

/**
 * 笔记快照表建表服务。
 *
 * 与部门表 / 会议纪要表同路径（ACMS 自建 SQL 表，不走飞书 Base），
 * 必须在启动期幂等建表，否则首次写入会因表不存在而失败。
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

import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';

/**
 * 「笔记状态表」的建表定义（ACMS 自建 SQL 表，不走飞书 Base）。
 *
 * 为什么单独一个文件、并且**两处都调它**：
 *   - `NoteSnapshotModule.onModuleInit`（启动期）—— 把表与字段元数据一次建好；
 *   - `GetnoteService`（读写前懒建）—— 部署后进程没重启、或启动建表失败时兜底，
 *     否则第一次点「归档」就会因表不存在而失败。
 * 字段元数据只留这一份：两处各写一份必然漂移（`ensureTable` 对字段是 upsert，
 * 漂移的结果是两套定义合在一起，日期/数字读出来就不对了）。
 *
 * 记录 id = 笔记 ID（上游 note_id，天然唯一，可幂等 upsert）。
 * ⚠️ **没有行 = 有效**：历史笔记不需要任何回填，这正是「历史数据都是有效」的实现方式。
 */
export const NOTE_STATUS_TABLE_FIELDS = [
  { name: '笔记ID', type: 1 },
  { name: '标题', type: 1 },
  { name: '状态', type: 1 },
  // ⚠️ 时间必须声明成 NUMBER（type=2）而不是 DATE（type=5）：
  //    type=5 读出来会被格式化成 "YYYY-MM-DD"，而归档时间要精确到秒
  //    —— 同一天内反复归档/激活，只留日期没法判断先后（与笔记快照表同款坑）。
  { name: '归档时间', type: 2 },
  { name: '归档人', type: 1 },
  { name: '归档人ID', type: 1 },
  { name: '激活时间', type: 2 },
  { name: '激活人', type: 1 },
] as const;

/** 是否已确保建表（同一进程只做一次） */
let ready = false;

/** 幂等建表：表存在则只 upsert 字段元数据。没有 DATABASE_URL（纯飞书模式）时静默跳过。 */
export async function ensureNoteStatusTable(): Promise<void> {
  if (ready) return;
  const sql = getSqlStore();
  if (!sql) return;
  await sql.ensureTable(TABLES.noteStatus.tableId, '笔记状态表', [...NOTE_STATUS_TABLE_FIELDS]);
  ready = true;
}

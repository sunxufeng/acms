import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

export interface AiDocRecord {
  id: string;
  title: string;
  content: string;
  ownerOpenId: string | null;
  refTable: string | null;
  refRecord: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AiDocRow {
  id: string;
  title: string;
  content: string;
  owner_open_id: string | null;
  ref_table: string | null;
  ref_record: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(r: AiDocRow): AiDocRecord {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    ownerOpenId: r.owner_open_id ?? null,
    refTable: r.ref_table ?? null,
    refRecord: r.ref_record ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function newId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * ACMS 内部文档存储（云文档内化）：
 * 文档（标题 + Markdown 正文 + 归属用户 + 可选关联记录）落 PostgreSQL ai_docs 表，
 * 不再依赖飞书云文档。AI 工具创建、用户在「AI 文档」页查看/编辑均走本服务。
 */
@Injectable()
export class AiDocsService {
  private readonly logger = new Logger(AiDocsService.name);
  private readonly pool: Pool | null;
  private ready: Promise<void> | null = null;

  constructor() {
    const url = process.env.DATABASE_URL?.trim();
    this.pool = url ? new Pool({ connectionString: url, max: 5 }) : null;
  }

  private ensure(): Promise<void> {
    if (!this.pool) throw new Error('AI 文档存储未配置（缺少 DATABASE_URL）');
    this.ready ??= (async () => {
      await this.pool!.query(`
        CREATE TABLE IF NOT EXISTS ai_docs (
          id text PRIMARY KEY,
          title text NOT NULL DEFAULT '未命名文档',
          content text NOT NULL DEFAULT '',
          owner_open_id text,
          ref_table text,
          ref_record text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ai_docs_owner_idx ON ai_docs (owner_open_id);
      `);
    })();
    return this.ready;
  }

  async create(input: {
    title?: string;
    content?: string;
    ownerOpenId?: string;
    refTable?: string;
    refRecord?: string;
  }): Promise<{ id: string; url: string }> {
    await this.ensure();
    const id = newId();
    await this.pool!.query(
      `INSERT INTO ai_docs (id, title, content, owner_open_id, ref_table, ref_record)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        (input.title ?? '未命名文档').slice(0, 200),
        input.content ?? '',
        input.ownerOpenId ?? null,
        input.refTable ?? null,
        input.refRecord ?? null,
      ],
    );
    return { id, url: `/ai-docs/${id}` };
  }

  async list(ownerOpenId?: string, isAdmin = false): Promise<AiDocRecord[]> {
    await this.ensure();
    const res = isAdmin
      ? await this.pool!.query<AiDocRow>(`SELECT * FROM ai_docs ORDER BY updated_at DESC LIMIT 200`)
      : ownerOpenId
        ? await this.pool!.query<AiDocRow>(`SELECT * FROM ai_docs WHERE owner_open_id = $1 ORDER BY updated_at DESC`, [ownerOpenId])
        : { rows: [] as AiDocRow[] };
    return res.rows.map(rowToRecord);
  }

  async get(id: string): Promise<AiDocRecord | null> {
    await this.ensure();
    const res = await this.pool!.query<AiDocRow>(`SELECT * FROM ai_docs WHERE id = $1`, [id]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async update(id: string, patch: { title?: string; content?: string }): Promise<void> {
    await this.ensure();
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.title !== undefined) sets.push(`title = $${params.push(patch.title.slice(0, 200))}`);
    if (patch.content !== undefined) sets.push(`content = $${params.push(patch.content)}`);
    if (!sets.length) return;
    sets.push(`updated_at = now()`);
    await this.pool!.query(`UPDATE ai_docs SET ${sets.join(', ')} WHERE id = $1`, params);
  }

  async remove(id: string): Promise<void> {
    await this.ensure();
    await this.pool!.query(`DELETE FROM ai_docs WHERE id = $1`, [id]);
  }
}

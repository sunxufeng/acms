import type { DataStore } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';

/** bitablePerm 鉴权上下文：素材归属（表 / 记录 / 附件字段） */
export interface BitablePermContext {
  tableId: string;
  recordId: string;
  fieldId: string;
}

/**
 * 飞书多维表格开启「高级权限」后，素材下载必须在 extra 里用 bitablePerm 声明归属，
 * 且**归属字段必须是附件类型(type=17)**；直连 `drive/v1/medias/:token/download`
 * 会返回 400。实测：用文本字段作上下文返回空数组，用附件字段作上下文 5/5 成功。
 *
 * 系统配置表已加「logo素材」附件字段，作为**全站附件下载的通用鉴权上下文**：
 * 只要素材是经 `uploadFile` 上传到该多维表格空间（parent_type=bitable_file），
 * 无论它挂在哪个业务表的哪条记录，都能用该上下文换取预签名下载链接。
 * （实测 5 张真实学生照片：直连全部 400，经此上下文全部 200 并能完整下载。）
 */
const LOGO_ATTACH_FIELD_NAME = 'logo素材';
/** 飞书为该字段生成的 field_id，作为元数据不同步时的最后兜底 */
const LOGO_ATTACH_FIELD_ID = 'fldhNMJqm2';

/** 进程级缓存：上下文是全局静态的，解析一次即可 */
let cached: Promise<BitablePermContext> | null = null;

/** 通过 TABLE_ID_MAP 把代码级表别名解析为真实表 ID */
function resolveRealTableId(alias: string): string {
  try {
    const raw = process.env.TABLE_ID_MAP;
    if (!raw) return alias;
    const map = JSON.parse(raw) as Record<string, string>;
    return map[alias] ?? alias;
  } catch {
    return alias;
  }
}

/**
 * 解析 bitablePerm 上下文（懒加载 + 进程级缓存）。
 * @param base 数据访问入口（BASE_CLIENT）
 * @param onWarn 可选告警回调（用于打日志）
 */
export function resolveBitablePermContext(
  base: DataStore,
  onWarn?: (msg: string) => void,
): Promise<BitablePermContext> {
  if (!cached) {
    cached = (async () => {
      try {
        const alias = TABLES.systemConfig.tableId;
        const records = await base.search(alias, { pageSize: 1 });
        const fields = await base.listFields(alias);
        const recId = records.items[0]?.recordId ?? '';
        // 优先按名匹配 logo 素材字段；兜底：任意附件字段 → 已知字段 id
        const logoField =
          fields.find((f) => f.name === LOGO_ATTACH_FIELD_NAME) ??
          fields.find((f) => f.type === 17) ??
          fields.find((f) => f.id === LOGO_ATTACH_FIELD_ID);
        const fldId = logoField?.id ?? LOGO_ATTACH_FIELD_ID;
        return { tableId: resolveRealTableId(alias), recordId: recId, fieldId: fldId };
      } catch (e) {
        onWarn?.(`bitablePerm 上下文解析失败: ${(e as Error).message}`);
        return { tableId: '', recordId: '', fieldId: '' };
      }
    })();
  }
  return cached;
}

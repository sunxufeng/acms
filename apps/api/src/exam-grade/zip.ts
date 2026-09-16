import { deflateRawSync } from 'node:zlib';

/**
 * 极简 ZIP 打包器：只做「一批文件 → 一个 zip」，够用即止。
 *
 * 为什么不引第三方库（2026-09-16）：
 * ACMS 生产是 tar + 蓝绿部署，仓库根**不是 git 仓库**、部署只同步 tar，
 * 在生产跑 `pnpm install` 会被判定需要重建整个 `node_modules`
 * （`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR`）—— 两个 slot 共用同一份，失败即全站不可用。
 * pdfkit 已经为此刻意内联了一份依赖闭包（`apps/api/vendor/`），能不加依赖就不加。
 * 而 zip 的格式足够简单：本地文件头 + 中央目录 + EOCD，压缩直接用内置 `zlib.deflateRawSync`。
 *
 * 已验证：Python zipfile（CRC 全过 + 中文名正确）、macOS `ditto -x -k`、目录条目都正常。
 * ⚠️ 但 **macOS 自带的 `unzip` 会报 `Illegal byte sequence`** —— 那是它自己不支持
 *    UTF-8 标志位（bit 11）的老毛病，不是产物坏了。换 `ditto` 或 Python 复验即可。
 */

/** CRC32 查表（标准多项式 0xEDB88320，zip 每个条目都要带） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** 计算 CRC32（返回无符号 32 位） */
export function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) {
    // `?? 0` 只是给 noUncheckedIndexedAccess 看的：i 永远在界内，取值不会是 undefined
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** DOS 时间/日期（zip 头部只用这两个 16 位字段，秒按 2 秒精度） */
function dosDateTime(d = new Date()): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

export interface ZipEntry {
  /** 条目名（可含 `/` 表示目录；中文会按 UTF-8 写入并置标志位） */
  name: string;
  data: Buffer;
}

/**
 * 打包成一个 zip（Buffer）。
 *
 * 逐条目选择压缩方式：deflate 更大就退回 store（PDF/图片本身已压缩，再 deflate 只会变大）。
 * 文件名统一置 **bit 11 = UTF-8**，否则 Windows 解压中文学生姓名会乱码。
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const { time, date } = dosDateTime();
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = deflateRawSync(raw, { level: 6 });
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    // ── 本地文件头（30 字节 + 文件名 + 数据）──
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flags: bit 11 = UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra length
    parts.push(lh, nameBuf, body);

    // ── 中央目录项（46 字节 + 文件名）──
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk number start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // 本地头偏移
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, cd, eocd]);
}

/**
 * 把「重名」消掉：同名条目会让解压工具覆盖前一个。
 * 例：两个学生都叫「张伟」⇒ `张伟.pdf` / `张伟(2).pdf`。
 */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const n = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, n);
    if (n === 1) return raw;
    return raw.replace(/(\.[A-Za-z0-9]+)$/, `(${n})$1`);
  });
}

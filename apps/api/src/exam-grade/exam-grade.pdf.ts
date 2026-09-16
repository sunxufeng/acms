/**
 * 成绩单 PDF 渲染 —— `pdfkit` + 子集化中文字体，**纯 JS，服务器零系统依赖**。
 *
 * 为什么不用「HTML → 无头浏览器打印」：
 *   生产服务器（114.215.186.106）实测**没有 Chromium、没有 wkhtmltopdf、没有任何中文字体**。
 *   而 ACMS 是 tar 包 + systemd 蓝绿的部署方式，塞 ~150MB 系统依赖会显著抬高部署风险。
 *
 * 字体：
 *   子集化 Noto Sans SC Regular（GB2312 全部汉字 + ASCII + 中文标点，7768 字形，2.2 MB）。
 *   实测输出一页成绩单约 **30 KB** —— pdfkit 会按实际用到的字形**再子集化一次**，
 *   内嵌的是 `CZZZZZ+NotoSansSC-Regular` 这样的子集，所以源字体大、产物很小。
 *
 * 🔴 字体文件不在 `tsc` 的产物里（api 用裸 tsc 构建，不拷非 TS 文件）。
 *    必须靠 `scripts/build_tars.sh` 补一步把 assets 复制进 `apps/api/dist/`，
 *    否则线上会报「找不到字体」。这里按顺序解析，找不到就**明确报错**，
 *    不静默降级成一张没有中文的空白 PDF。
 *
 * ⚠️ 数据来自 `ExamGradeService.buildReportCard()`，**与屏幕预览同一份**。
 *    这个文件只负责排版，不重新计算任何口径。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportCardData } from './exam-grade.service.js';

// pdfkit 没有自带类型声明，这里只声明用到的那部分
interface PdfDoc {
  font(name: string): PdfDoc;
  fontSize(n: number): PdfDoc;
  fillColor(c: string): PdfDoc;
  text(t: string, x?: number, y?: number, opts?: Record<string, unknown>): PdfDoc;
  moveTo(x: number, y: number): PdfDoc;
  lineTo(x: number, y: number): PdfDoc;
  strokeColor(c: string): PdfDoc;
  lineWidth(n: number): PdfDoc;
  stroke(): PdfDoc;
  rect(x: number, y: number, w: number, h: number): PdfDoc;
  fill(c?: string): PdfDoc;
  heightOfString(t: string, opts?: Record<string, unknown>): number;
  registerFont(name: string, src: string): PdfDoc;
  addPage(): PdfDoc;
  pipe(dest: NodeJS.WritableStream): PdfDoc;
  end(): void;
  y: number;
  page: { width: number; height: number };
}
type PdfCtor = new (opts?: Record<string, unknown>) => PdfDoc;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument: PdfCtor = require('pdfkit');

/** 模块级缓存：2.2 MB 字体每次请求重新解析会明显变慢 */
let fontPathCache: string | null = null;

function resolveFontPath(): string {
  if (fontPathCache) return fontPathCache;
  const candidates = [
    process.env.REPORT_FONT_PATH,
    join(__dirname, 'assets', 'report-card-cn.ttf'),
    join(process.cwd(), 'apps', 'api', 'src', 'exam-grade', 'assets', 'report-card-cn.ttf'),
  ].filter(Boolean) as string[];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      `[exam-grade] 找不到成绩单字体。已尝试：${candidates.join(' | ')}。` +
        '请确认 scripts/build_tars.sh 已把 src/exam-grade/assets 复制进 dist。',
    );
  }
  fontPathCache = hit;
  return hit;
}

const A4 = { width: 595.28, height: 841.89 };
const M = 40; // 页边距
const CONTENT_W = A4.width - M * 2;

/** 各科总评表的列宽（评语列吃掉剩余宽度 —— 它是这张表最该读的内容） */
const COLS: { label: string; w: number; key: string }[] = [
  { label: '科目', w: 84, key: 'subject' },
  { label: '总评', w: 52, key: 'total' },
  { label: '等级', w: 46, key: 'level' },
  { label: '班级排名', w: 62, key: 'rank' },
  { label: '任课教师评语', w: 0, key: 'comment' }, // 0 = 弹性
];

function fmt(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}

function fmtDate(v: unknown): string {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 渲染一份成绩单，返回完整 PDF Buffer */
export async function renderReportCardPdf(data: ReportCardData): Promise<Buffer> {
  const font = resolveFontPath();

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ size: 'A4', margin: M, autoFirstPage: true });
      // pdfkit 的 PDFDocument 是可读流：pipe 到一个内存 Writable 收集分片
      const sink = new (require('node:stream').Writable)({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      sink.on('finish', () => resolve(Buffer.concat(chunks)));
      sink.on('error', reject);
      doc.pipe(sink);

      doc.registerFont('cn', font);
      doc.font('cn');

      let y = M;

      // ── 页眉 ────────────────────────────────────────────────
      doc.fillColor('#0b6a60').fontSize(11).text('致极学院 · Arete College', M, y, { width: 260 });
      doc.fillColor('#8a9a98').fontSize(7.5).text('ARETE AI LAB · STUDENT INFORMATION SYSTEM', M, y + 15, { width: 300 });
      doc.fillColor('#111111').fontSize(19).text('成绩单', M, y - 2, { width: CONTENT_W, align: 'right' });
      doc.fillColor('#777777').fontSize(8).text('REPORT CARD', M, y + 20, { width: CONTENT_W, align: 'right' });
      y += 34;
      doc.moveTo(M, y).lineTo(M + CONTENT_W, y).strokeColor('#0E9B8E').lineWidth(1.4).stroke();
      y += 14;

      // ── 学生信息（两列四行） ─────────────────────────────────
      const info: [string, string][] = [
        ['学生姓名', data.studentName],
        ['学号', data.studentNo || '—'],
        ['年级 / 班级', data.cls || '—'],
        ['批次', data.batchName],
        ['学年 / 学期', [data.year, data.term].filter(Boolean).join(' · ') || '—'],
        ['成绩单状态', data.batchStatus === '已发布' ? '已发布' : '草稿（未发布）'],
      ];
      doc.fontSize(9);
      for (let i = 0; i < info.length; i++) {
        const item = info[i];
        if (!item) continue;
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = M + col * (CONTENT_W / 2);
        const yy = y + row * 17;
        doc.fillColor('#777777').text(item[0], x, yy, { width: 74 });
        doc.fillColor('#111111').text(item[1], x + 74, yy, { width: CONTENT_W / 2 - 84, ellipsis: true });
      }
      y += Math.ceil(info.length / 2) * 17 + 10;

      // ── 各科总评表 ───────────────────────────────────────────
      doc.fillColor('#0b6a60').fontSize(10).text('各科总评', M, y);
      y += 16;

      const fixedW = COLS.reduce((a, c) => a + c.w, 0);
      const flexW = CONTENT_W - fixedW;
      const widths = COLS.map((c) => (c.w === 0 ? flexW : c.w));

      const drawHead = (yy: number): number => {
        doc.rect(M, yy, CONTENT_W, 20).fill('#EEF4F3');
        doc.fillColor('#0b6a60').fontSize(8);
        let x = M;
        COLS.forEach((c, i) => {
          const w = widths[i] ?? 0;
          doc.text(c.label, x + 6, yy + 6, { width: w - 12 });
          x += w;
        });
        return yy + 20;
      };
      y = drawHead(y);

      data.subjects.forEach((s, idx) => {
        // ⚠️ 必须先把字号设成最终渲染用的 9 再量高度 —— 否则量的是上一段残留的字号
        //    （表头是 8），行高按 8 算、正文按 9 画，pdfkit 会把放不下的文字截断成省略号。
        doc.fontSize(9);
        const commentW = (widths[4] ?? 0) - 12;
        const commentH = doc.heightOfString(s.comment || '—', { width: commentW, lineGap: 1 });
        const rowH = Math.max(24, commentH + 12);
        if (y + rowH > A4.height - 90) {
          doc.addPage();
          y = M;
          y = drawHead(y);
        }
        if (idx % 2 === 1) doc.rect(M, y, CONTENT_W, rowH).fill('#FAFCFC');
        const cells = [
          s.subject,
          fmt(s.total),
          s.level || '—',
          s.rank == null ? '—' : `${s.rank} / ${s.rankTotal || '—'}`,
          s.comment || (s.status === '草稿' ? '（本条总评尚未确认）' : '—'),
        ];
        let x = M;
        doc.fontSize(9);
        cells.forEach((cell, i) => {
          const w = (widths[i] ?? 0) - 12;
          // 等级用颜色区分（深色打印也分得出深浅）
          if (i === 2 && s.level) doc.fillColor(levelColor(s.level));
          else if (i === 4) doc.fillColor(s.comment ? '#333333' : '#aaaaaa');
          else doc.fillColor('#222222');
          doc.text(cell, x + 6, y + 6, { width: w, lineGap: 1 });
          x += (widths[i] ?? 0);
        });
        doc.moveTo(M, y + rowH).lineTo(M + CONTENT_W, y + rowH).strokeColor('#E6ECEB').lineWidth(0.5).stroke();
        y += rowH;
      });

      y += 14;

      // ── 汇总 ─────────────────────────────────────────────────
      doc.fillColor('#0b6a60').fontSize(10).text('汇总', M, y);
      y += 16;
      const bits: string[] = [];
      // 没配绩点就不显示 GPA 项（而不是显示 0.00）
      if (data.gpa.weighted != null) bits.push(`加权 GPA ${fmt(data.gpa.weighted, 2)}`);
      if (data.gpa.unweighted != null) bits.push(`不加权 GPA ${fmt(data.gpa.unweighted, 2)}`);
      if (data.rank != null) bits.push(`班级排名 ${data.rank} / ${data.rankTotal || '—'}`);
      bits.push(`达标科目 ${data.attainedCount} / ${data.subjects.length}`);
      if (data.confirmedAt) bits.push(`总评确认时间 ${fmtDate(data.confirmedAt)}`);
      doc.fillColor('#222222').fontSize(9).text(bits.join('　·　'), M, y, { width: CONTENT_W });
      y += 26;

      // ── 班主任总评语 ─────────────────────────────────────────
      if (data.summaryComment) {
        if (y > A4.height - 170) {
          doc.addPage();
          y = M;
        }
        doc.fillColor('#0b6a60').fontSize(10).text('班主任总评语', M, y);
        y += 15;
        const h = doc.heightOfString(data.summaryComment, { width: CONTENT_W - 22, lineGap: 2.5 });
        doc.rect(M, y, CONTENT_W, h + 16).fill('#F7FAFA');
        doc.rect(M, y, 3, h + 16).fill('#0E9B8E');
        doc.fillColor('#333333').fontSize(9).text(data.summaryComment, M + 12, y + 8, {
          width: CONTENT_W - 24,
          lineGap: 2.5,
        });
        y += h + 16 + 18;
      }

      // ── 页脚 / 签字线 ────────────────────────────────────────
      const footY = A4.height - 62;
      doc.moveTo(M + CONTENT_W - 170, footY).lineTo(M + CONTENT_W, footY).strokeColor('#999999').lineWidth(0.6).stroke();
      doc.fillColor('#666666').fontSize(8).text('班主任签名 / 日期', M + CONTENT_W - 170, footY + 4, { width: 170, align: 'center' });
      doc
        .fillColor('#8a9a98')
        .fontSize(7.5)
        .text(
          `生成时间 ${fmtDate(Date.now())}　·　本成绩单由 ACMS 自动生成，如有疑问请联系班主任`,
          M,
          footY + 4,
          { width: CONTENT_W - 180 },
        );

      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}

/** 等级 → 打印友好的颜色（深色打印下靠层级区分，不靠色相） */
function levelColor(level: string): string {
  const first = level.trim().charAt(0).toUpperCase();
  if (first === 'A') return '#0b8a7e';
  if (first === 'B') return '#2b6cf6';
  if (first === 'C') return '#946200';
  if (first === 'D') return '#b2560d';
  if (first === 'E' || first === 'F' || first === 'U') return '#c0221f';
  return '#333333';
}

import { Inject, Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BaseClient, toText, type BaseRecord } from '@acms/base-adapter';
import { TABLES, type SessionUser } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';
import { SessionService } from '../auth/session.service.js';

const STUDENT_TABLE = TABLES.studentProfile.tableId;
const DATA_DIR = process.env.ACMS_DATA_DIR ?? '/opt/acms/data';
const STORE_FILE = path.join(DATA_DIR, 'student-accounts.json');

/** 学生密码账号（本地持久化，与飞书 Base 解耦，使用 scrypt 加盐哈希） */
export interface StudentAccount {
  /** 学生编号（登录账号，唯一键） */
  studentNo: string;
  /** scrypt 盐（hex） */
  salt: string;
  /** scrypt 哈希（hex） */
  hash: string;
  /** 关联学生档案 record_id（写入会话） */
  studentId: string;
  /** 姓名（冗余，便于会话展示） */
  name: string;
  /** 校区（冗余，便于会话 campus 限定） */
  campus: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 学生密码登录账号模块（B1）。
 *  - 账号以「学生编号」为唯一键，密码使用 scrypt(salt, 64) 加盐哈希，持久化于本地 JSON 文件。
 *  - 登录 / 自助设密均复用现有 SessionService（角色 ['student']，写入 studentId）。
 *  - 找回身份需「学号 + 姓名」匹配学生档案（与小程序绑定一致）。
 */
@Injectable()
export class StudentAuthService {
  private readonly logger = new Logger(StudentAuthService.name);
  /** studentNo → 账号（内存镜像，启动时从文件加载；写入即落盘） */
  private accounts = new Map<string, StudentAccount>();

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly sessions: SessionService,
  ) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const arr = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as StudentAccount[];
        for (const a of arr) this.accounts.set(a.studentNo, a);
      }
    } catch (e) {
      this.logger.warn(`学生账号加载失败，将以空表启动：${(e as Error).message}`);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify([...this.accounts.values()], null, 2), 'utf-8');
    } catch (e) {
      this.logger.warn(`学生账号持久化失败：${(e as Error).message}`);
    }
  }

  private genSalt(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private hashPassword(password: string, salt: string): string {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  /** 学号（学生编号）+ 姓名 → 学生档案（与小程序绑定逻辑一致） */
  private async findStudent(studentNo: string, name: string): Promise<BaseRecord | null> {
    const res = await this.base.search(STUDENT_TABLE, {
      pageSize: 50,
      filter: buildFilter([{ field: '学生姓名', value: [name] }]),
    });
    const no = String(studentNo).trim();
    return (
      res.items.find((r) => {
        const f = r.fields;
        const nameOk = toText(f['学生姓名']) === name.trim();
        if (!nameOk) return false;
        const noOk =
          String(toText(f['学生编号']) ?? '').trim() === no ||
          String(toText(f['学籍号（脱敏）']) ?? '').trim() === no;
        return noOk;
      }) || null
    );
  }

  /** 仅按学生编号定位学生（管理员场景，无需姓名校验） */
  private async findByNo(studentNo: string): Promise<BaseRecord | null> {
    const no = String(studentNo).trim();
    const res = await this.base.search(STUDENT_TABLE, {
      pageSize: 100,
      filter: buildFilter([{ field: '学生编号', value: [no] }]),
    });
    return res.items.find((r) => String(toText(r.fields['学生编号']) ?? '').trim() === no) || null;
  }

  private async loadStudent(id: string): Promise<BaseRecord | null> {
    try {
      return await this.base.get(STUDENT_TABLE, id);
    } catch {
      return null;
    }
  }

  /** 是否已开户（供学生账号管理页展示） */
  hasAccount(studentNo: string): boolean {
    return this.accounts.has(String(studentNo).trim());
  }

  /** 全部已开户账号（供管理员查看密码账号清单） */
  listAccounts(): Array<{
    studentNo: string;
    name: string;
    studentId: string;
    campus: string;
    createdAt: string;
    updatedAt: string;
  }> {
    return [...this.accounts.values()].map((a) => ({
      studentNo: a.studentNo,
      name: a.name,
      studentId: a.studentId,
      campus: a.campus,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
  }

  /** 按学号 / 姓名关键字检索学生档案，并标注是否已开户（供管理员设密） */
  async searchStudents(keyword: string): Promise<
    Array<{
      studentNo: string;
      name: string;
      studentId: string;
      campus: string;
      hasAccount: boolean;
    }>
  > {
    const kw = String(keyword ?? '').trim();
    if (!kw) return [];
    const res = await this.base.search(STUDENT_TABLE, {
      pageSize: 100,
      filter: {
        conjunction: 'or',
        conditions: [
          { field: '学生姓名', op: 'contains', value: [kw] },
          { field: '学生编号', op: 'contains', value: [kw] },
        ],
      },
    });
    return res.items.map((r) => {
      const f = r.fields;
      const no = String(toText(f['学生编号']) ?? '').trim();
      return {
        studentNo: no,
        name: toText(f['学生姓名']) ?? '',
        studentId: r.recordId,
        campus: toText(f['校区']) ?? '',
        hasAccount: this.accounts.has(no),
      };
    });
  }

  /** 学生密码登录 → 签发会话 */
  async login(studentNo: string, password: string): Promise<SessionUser> {
    const no = String(studentNo).trim();
    if (!no || !password) throw new BadRequestException('VALIDATION:需学号与密码');
    const acc = this.accounts.get(no);
    if (!acc) throw new UnauthorizedException('NO_ACCOUNT:该学号尚未设置登录密码');
    const hash = this.hashPassword(password, acc.salt);
    if (hash !== acc.hash) throw new UnauthorizedException('BAD_CREDENTIALS:学号或密码错误');
    // 重新读取档案以保证会话信息为最新
    const stu = await this.loadStudent(acc.studentId);
    const name = stu ? (toText(stu.fields['学生姓名']) ?? acc.name) : acc.name;
    const campus = stu ? (toText(stu.fields['校区']) ?? acc.campus) : acc.campus;
    return this.sessions.create({
      openId: `student_${acc.studentId}`,
      name,
      roles: ['student'],
      campuses: campus ? [campus] : [],
      maxDataLevel: 'L1',
      studentId: acc.studentId,
    });
  }

  /** 学生自助设置密码（先验证身份：学号 + 姓名），成功后直接登录 */
  async setPassword(studentNo: string, name: string, password: string): Promise<SessionUser> {
    if (!studentNo || !name || !password) throw new BadRequestException('VALIDATION:需学号、姓名与密码');
    if (String(password).length < 6) throw new BadRequestException('VALIDATION:密码至少 6 位');
    const stu = await this.findStudent(studentNo, name);
    if (!stu) throw new UnauthorizedException('STUDENT_NOT_FOUND:学号或姓名不匹配');
    const no = String(studentNo).trim();
    const salt = this.genSalt();
    const hash = this.hashPassword(password, salt);
    const now = new Date().toISOString();
    const campus = toText(stu.fields['校区']) ?? '';
    const displayName = toText(stu.fields['学生姓名']) ?? name;
    const prev = this.accounts.get(no);
    this.accounts.set(no, {
      studentNo: no,
      salt,
      hash,
      studentId: stu.recordId,
      name: displayName,
      campus,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
    this.persist();
    return this.sessions.create({
      openId: `student_${stu.recordId}`,
      name: displayName,
      roles: ['student'],
      campuses: campus ? [campus] : [],
      maxDataLevel: 'L1',
      studentId: stu.recordId,
    });
  }

  /** 管理员为学生设置密码（无需姓名校验） */
  async setPasswordByAdmin(studentNo: string, password: string): Promise<{ ok: boolean }> {
    if (!studentNo || !password) throw new BadRequestException('VALIDATION:需学号与密码');
    if (String(password).length < 6) throw new BadRequestException('VALIDATION:密码至少 6 位');
    const no = String(studentNo).trim();
    const stu = await this.findByNo(no);
    const now = new Date().toISOString();
    const campus = stu ? (toText(stu.fields['校区']) ?? '') : '';
    const displayName = stu ? (toText(stu.fields['学生姓名']) ?? no) : no;
    const studentId = stu?.recordId ?? '';
    const prev = this.accounts.get(no);
    const salt = this.genSalt();
    this.accounts.set(no, {
      studentNo: no,
      salt,
      hash: this.hashPassword(password, salt),
      studentId,
      name: displayName,
      campus,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
    this.persist();
    return { ok: true };
  }
}

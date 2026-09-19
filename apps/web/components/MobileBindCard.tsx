'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

export interface MobileBindCardProps {
  /** 卡片标题（页面各自提供，已 i18n） */
  title: string;
  /** 标题下的一行说明（页面各自提供，已 i18n） */
  description: string;
  /** 主按钮文案，如「绑定」/「登录」 */
  submitLabel: string;
  /** 提交中的按钮文案，如「绑定中…」 */
  busyLabel: string;
  /** 提交中：禁用按钮并显示 busyLabel */
  busy: boolean;
  /** 业务错误（网络/校验失败），由页面写入；组件内字段为空的提示优先级低于它 */
  error?: string;
  /**
   * 校验通过后的提交回调，收到已 trim 的学号与姓名（第三个参数仅当 `showPhone` 时才有值）。
   * 第三个参数是可选的，所以「不需要手机号」的调用方（学生登录）不用改签名。
   */
  onSubmit: (studentNo: string, name: string, phone?: string) => void;
  /**
   * 是否显示「家长手机号（选填）」（2026-09-19，issue #2 多子女）。
   *
   * 为什么手机号决定多子女：家长身份键取「手机号」时，同一家长下再绑第二个孩子
   * 会自动进同一份子女名单，于是能切换。不填则维持历史行为（一个孩子一个身份）。
   * 只在**家长绑定**场景打开；学生登录不需要，也不该被要求填家长手机号。
   */
  showPhone?: boolean;
  /** 卡片底部插槽，用于放「我是教职工？」之类的次要链接 */
  children?: React.ReactNode;
}

/**
 * 移动端「学号 + 姓名」绑定卡片 —— /student-login 与 /parent 绑定态的公共组件。
 *
 * 为什么抽：两页原本各有一份几乎逐行相同的实现（6 个内联样式常量 + 同构表单），
 * 且都把 #f5f6fa / #fff / #8a90a2 / #e3e5ec / #4f46e5 写死在页内，在默认的
 * 「月之暗面」暗色主题下是刺眼的白卡片 + 靛蓝按钮，与品牌青绿 #4ECDC4 也冲突。
 * 抽出来后两页只剩各自的业务回调差异。
 *
 * 样式 100% 复用既有标准类，不自绘：
 *   .mobile-page / .mobile-card / .mobile-title / .mobile-desc   —— 布局（globals.css）
 *   .card                                                        —— 表面/边框/内边距
 *   .form-input / .mobile-field                                  —— 输入框
 *   .btn .btn-primary / .mobile-btn                              —— 品牌青绿胶囊按钮
 *   .msg-error                                                   —— 错误提示
 * 组件内置 3 条 i18n（学号 / 学生姓名 / 请填写学号和姓名），取 bind 命名空间。
 */
export default function MobileBindCard({
  title,
  description,
  submitLabel,
  busyLabel,
  busy,
  error,
  onSubmit,
  showPhone,
  children,
}: MobileBindCardProps) {
  const t = useTranslations('bind');
  const [studentNo, setStudentNo] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  // 只表示「两个字段没填全」，业务错误由 error 传入，两者取其一展示
  const [fieldErr, setFieldErr] = useState('');

  function submit() {
    if (busy) return;
    setFieldErr('');
    const no = studentNo.trim();
    const nm = name.trim();
    if (!no || !nm) {
      setFieldErr(t('requiredFields'));
      return;
    }
    onSubmit(no, nm, phone.trim() || undefined);
  }

  const shownError = error || fieldErr;

  return (
    <div className="mobile-page">
      <div className="card mobile-card mobile-card-offset">
        <h1 className="mobile-title">{title}</h1>
        <p className="mobile-desc">{description}</p>

        <input
          className="form-input mobile-field"
          placeholder={t('studentNo')}
          value={studentNo}
          onChange={(e) => setStudentNo(e.target.value)}
        />
        <input
          className="form-input mobile-field"
          placeholder={t('studentName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {showPhone && (
          /* 选填：填了才能在同一账号下管理多个子女（家长身份按手机号聚合） */
          <input
            className="form-input mobile-field"
            placeholder={t('parentPhone')}
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        )}

        {shownError && <p className="msg-error">{shownError}</p>}

        <button type="button" className="btn btn-primary mobile-btn" onClick={submit} disabled={busy}>
          {busy ? busyLabel : submitLabel}
        </button>

        {children}
      </div>
    </div>
  );
}

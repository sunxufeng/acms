import { redirect } from 'next/navigation';

/**
 * 「编辑 IDP 沟通」（旧地址）—— 2026-09-21 已并入「学生记录」。
 *
 * 那条记录如果还在（表是 0 行，所以实际上没有），现在应当从「学生记录」里以
 * 记录类型 = IDP沟通 打开编辑。这里不尝试按 cid 找回旧记录：
 * 两张表的主键不同源，猜的映射只会带来更难查的问题。
 * 用 307 而不是永久重定向的理由同 `communications/page.tsx`。
 */
export default function EditIdpCommunicationRedirect() {
  redirect('/student-records?type=' + encodeURIComponent('IDP沟通'));
}

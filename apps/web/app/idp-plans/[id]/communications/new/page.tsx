import { redirect } from 'next/navigation';

/**
 * 「新增 IDP 沟通」（旧地址）—— 2026-09-21 已并入「学生记录」。
 *
 * 现在记 IDP 沟通的动线是：学生记录 → 顶部 Tab 选「IDP沟通」→ 新建。
 * 见 `app/idp-plans/page.tsx` 顶部注释（为什么收起来）。
 * 用 307 而不是永久重定向的理由同 `communications/page.tsx`。
 */
export default function NewIdpCommunicationRedirect() {
  redirect('/student-records?type=' + encodeURIComponent('IDP沟通'));
}

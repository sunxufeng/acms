import { redirect } from 'next/navigation';

/**
 * IDP 沟通记录（旧地址）—— 2026-09-21 已并入「学生记录」。
 *
 * 原来这里是挂在某个 IDP 方案下的沟通列表；现在「学生记录」里多了一个记录类型
 * 「IDP沟通」（内容与日常跟进完全相同），统一在那里记，避免"两处都能记、各读一处"。
 *
 * ⚠️ 用 redirect（307）而不是 permanentRedirect（308）：永久重定向会被浏览器长期缓存，
 *    万一以后要把 IDP 沟通挪回方案下，用户端会一直打到旧地址，很难纠正。
 * ⚠️ 这里**带不上 planId 的过滤**（学生记录里的 IDP沟通 不区分方案）——
 *    所以降级到「该类型的全部记录」，而不是 404，老书签不会失效。
 */
export default function IdpCommunicationsRedirect() {
  redirect('/student-records?type=' + encodeURIComponent('IDP沟通'));
}

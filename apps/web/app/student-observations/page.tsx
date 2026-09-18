import { redirect } from 'next/navigation';

// 「学生观察」已并入「学生记录」（2026-09-18）：三类记录共用一张表，靠「记录类型」区分。
// 旧地址保留为**临时重定向**并带上对应类型 Tab —— 已收藏/已分享的链接不失效。
// ⚠️ 用 redirect（307）而不是 permanentRedirect（308）：永久重定向会被浏览器长期缓存。
export default function StudentObservationsRedirect() {
  redirect('/student-records?type=' + encodeURIComponent('学生观察'));
}

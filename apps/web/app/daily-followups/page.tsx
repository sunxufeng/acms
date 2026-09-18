import { redirect } from 'next/navigation';

// 「日常跟进」已并入「学生记录」（2026-09-18）：三类记录共用一张表，靠「记录类型」区分。
// 旧地址保留为**临时重定向**并带上对应类型 Tab —— 已收藏/已分享的链接不失效。
// ⚠️ 用 redirect（307）而不是 permanentRedirect（308）：永久重定向会被浏览器长期缓存，
//    万一以后要拆回去或改路径，用户端会一直打到旧地址，很难纠正。
export default function DailyFollowupsRedirect() {
  redirect('/student-records?type=' + encodeURIComponent('日常跟进'));
}

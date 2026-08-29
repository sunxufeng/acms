import { redirect } from 'next/navigation';

// 编辑学生档案已改为在 /students 列表页内的独立表单页完成（URL 保持不变，与全站统一），
// 旧路由保留仅用于让已有收藏/分享链接重定向回列表页，不直接 404。
// 注意：/students/[id] 只读详情页保留不动（可分享、可新标签打开）。
export default function EditStudentRedirect() {
  redirect('/students');
}

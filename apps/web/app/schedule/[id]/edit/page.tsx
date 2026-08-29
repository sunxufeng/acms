import { redirect } from 'next/navigation';

// 编辑课次已改为在 /schedule 列表页内的独立表单页完成（与全站统一的 standaloneForm 交互），
// 旧路由保留仅用于让已有收藏/分享链接重定向回列表页，不直接 404。
export default function EditSessionRedirect() {
  redirect('/schedule');
}

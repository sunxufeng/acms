import { redirect } from 'next/navigation';

// 新建 IDP 方案已改为在 /idp-plans 列表页内的独立表单页完成（URL 保持不变，与全站统一），
// 旧路由保留仅用于让已有收藏/分享链接重定向回列表页，不直接 404。
export default function NewIdpPlanRedirect() {
  redirect('/idp-plans');
}

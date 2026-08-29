import { redirect } from 'next/navigation';

// 新建 API 配置已改为在 /ai/config 页内的独立表单页完成（URL 保持不变，与全站统一），
// 旧路由保留仅用于让已有收藏/分享链接重定向回列表页，不直接 404。
export default function NewApiConfigRedirect() {
  redirect('/ai/config');
}

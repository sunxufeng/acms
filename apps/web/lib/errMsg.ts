/**
 * 把后端抛的错误码翻译成人话（2026-09-23）。
 *
 * 起因：招生老师点「+ 加入」时弹的是 `关联失败：FORBIDDEN:module:mailArchive:update` ——
 * 老师既不知道这是什么，也不知道该找谁。根因已修（该接口的判据降到 read），
 * 但**任何**自建接口仍可能抛这类码，前端不该把原始码直接糊到用户脸上。
 *
 * 只翻译「确定含义」的几种；其余原样返回 —— 猜错了比不翻译更糟。
 */
export function humanizeError(e: unknown): string {
  const raw = e as { message?: unknown } | null | undefined;
  const m = String(raw?.message ?? e ?? '').trim();
  if (!m) return '操作失败（后端未返回原因）';
  if (m.startsWith('FORBIDDEN:')) {
    const perm = m.slice('FORBIDDEN:'.length);
    return `你没有权限执行这个操作（需要权限点 ${perm}）。若确实需要，请联系系统管理员在「角色管理」里授权。`;
  }
  if (m === 'NOT_FOUND') return '记录不存在，或不在你的可见范围内。';
  if (m === 'UNAUTHORIZED' || m === '401') return '登录已过期，请重新登录。';
  return m;
}

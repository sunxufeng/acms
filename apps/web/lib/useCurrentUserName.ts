'use client';

import { useEffect, useState } from 'react';
import { currentUserName } from './noteAutoFill';

/**
 * 当前登录用户的姓名（异步取一次，全站缓存；取不到返回空串）。
 *
 * 用途：新建表单的「负责人 / 跟进人」默认值。**为什么值得单独一个 hook**：
 * 招生跟进、校友长期跟进、实践活动三处都要这个默认值，各写一遍 `useEffect + catch`
 * 必然有人漏掉 catch（最后是 unhandled rejection）或忘了空值兜底。
 *
 * 注意：这里只是**让表单打开就能看见**默认值；真正的兜底在服务端
 * （`RecordMeta.defaults`，接口直连 / 导入 / 转换都要一致）。
 */
export function useCurrentUserName(): string {
  const [me, setMe] = useState('');
  useEffect(() => {
    let alive = true;
    currentUserName()
      .then((n) => {
        if (alive) setMe(n || '');
      })
      .catch(() => {
        if (alive) setMe('');
      });
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

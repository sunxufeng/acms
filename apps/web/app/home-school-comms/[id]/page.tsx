'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

// 详情页已并入「学生记录」（2026-09-18）。
// 记录 id 在迁移时**原样保留**，所以直接把 id 带过去 —— 旧书签仍落在同一条记录上。
export default function HomeSchoolCommDetailRedirect() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  useEffect(() => {
    router.replace(`/student-records/${id}`);
  }, [id, router]);
  return null;
}

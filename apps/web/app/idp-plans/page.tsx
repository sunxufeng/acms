'use client';

import CrudPage from '../../components/CrudPage';
import { api } from '../../lib/api';
import { COLUMNS, parseIdpFromSummary } from './columns';
import PlanForm from '../../components/idp/PlanForm';

/**
 * IDP方案（父表）。
 *
 * 🔴 2026-09-21：**移除了行级的「沟通记录 / 新增沟通」两个动作**。
 *    IDP 沟通已并入「学生记录」（记录类型 = IDP沟通，内容与日常跟进完全相同）——
 *    原来这里的两个按钮 + 方案详情页内嵌的沟通列表 = **第三个入口**，
 *    继续留着就会出现「同一件事一半记在这、一半记在那」，而学生全景 / 搜索 / AI 各读一处。
 *
 *    为什么是「学生记录」而不是继续挂在方案下：
 *      · 一处入口，不必先建方案才能记沟通；
 *      · 学生全景、搜索、AI 汇总、导出天然都能看到（它们都读学生记录）；
 *      · 权限沿用「日常跟进」，一个角色配置都不用改。
 *
 *    数据：那张独立的 IDP沟通表当时是 **0 行**，所以收起入口没有丢任何数据。
 *    要恢复：`git log -- apps/web/app/idp-plans` 找回本文件与 [id]/page.tsx 的对应片段，
 *    以及 `components/idp/CommunicationManager.tsx`（组件未删，只是不再被挂载）。
 */
export default function IdpPlansPage() {
  return (
    <CrudPage
      moduleKey="idpPlans"
      title="IDP管理"
      subtitle="IDP管理"
      search={{ placeholder: '搜索学生…' }}
      columns={COLUMNS}
        enrichPrefill={parseIdpFromSummary}
      statusField="状态"
      inlineEdit
      standaloneForm
      renderForm={({ row, onDone }) => (
        <PlanForm planId={row?.id != null ? String(row.id) : undefined} onDone={onDone} />
      )}
      detailHref={(id) => `/idp-plans/${id}`}
      api={{
        list: (p) => api.listIdpPlans(p),
        create: (d) => api.createIdpPlan(d),
        update: (id, d) => api.updateIdpPlan(id, d),
        archive: (id) => api.archiveIdpPlan(id),
      }}
    />
  );
}

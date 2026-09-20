'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 学生成绩目标（教学管理，2026-09-20 补页面）。
 *
 * 存在的意义：成绩册里「是否达标」这一列**必须有个人目标才算得出来** ——
 * 判定是 `条目等级序号 ≤ 目标等级序号`。没有目标记录时，成绩册在该列写「未设目标」，
 * 而不是「不达标」（两者语义差得远，别混）。
 *
 * 🔴 两个容易搞反的点，直接写在字段提示里：
 *  1. **等级序号越小越好**（1 为最好）—— 所以「达标」是序号 **≤** 目标序号，
 *     与直觉的「分数 ≥ 及格线」方向相反。
 *  2. 「班级」要与成绩册的班级一致（= 学生档案的「当前年级」），
 *     因为成绩册是按班级分组取名单的。
 *
 * 学生字段存的是学生档案的 record id（与成绩册条目的「学生」同口径），
 * 因此本页**沿用同一套学生档案数据范围**：老师看不到授权范围之外的学生目标。
 */
export default function MarkbookTargetsPage() {
  const t = useTranslations('teaching');

  /**
   * 成绩等级候选（= 成绩等级表里该体系的实际序号与显示值）。
   *
   * 🔴 为什么「目标等级序号」必须是下拉、不能是自由数字（2026-09-20 修）：
   * 这个值必须**恰好等于某个等级的序号**才有意义 —— 达标判定是 `实际等级序号 ≤ 目标序号`。
   * 生产实测有人填了 `1`，而本校「致极等第体系-2026」的序号是
   * **10 / 15 / 20 / 25 / 27 / 30 / 35 / 40 / 50 / 60**（A 最好 = 10，**没有 1**）⇒
   * 那条目标**永远判不出达标**（哪怕全 A），成绩册里也显示不出等级名、只剩一个裸序号。
   * 下拉的 label 做成「A（序号 10）」，让「越小越好」这件事在选项里直接可见。
   *
   * 读不到等级表（接口失败）时退回数字输入 —— 不能因为一个只读候选就把「建目标」这件事卡死。
   */
  const [levels, setLevels] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .markbookLevelOptions()
      .then((r) => {
        if (alive) setLevels(r?.items ?? []);
      })
      .catch(() => {
        if (alive) setLevels([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const COLUMNS: CrudColumn[] = useMemo(
    () => [
      {
        key: '学生',
        label: t('colTargetStudent'),
        width: '150px',
        form: true,
        // studentLink：候选来自学生档案，存的 value 是 record id（列表由后端解析成姓名）
        type: 'studentLink',
        required: true,
      },
      {
        key: '班级',
        label: t('colTargetClass'),
        width: '130px',
        filter: true,
        form: true,
        // 读字典「当前年级」：成绩册是按「学生档案.当前年级」分组的，用同一份名单才不会写错班名
        type: 'select',
        dictKey: '当前年级',
        // 🔴 选中学生后**自动带出档案里的班级**（2026-09-20 加）：
        // 成绩册取目标时是**按班级过滤**的（`normClass(目标.班级) === 网格的班级`），
        // 这里手选错了班级，那条目标在成绩册里**永远不出现**，而且不报错、没日志。
        // 口径与后端 classOf 一致：当前班级 → 当前年级。带出后仍可手改。
        studentClassAuto: true,
        hint: t('hintTargetClass'),
      },
      // 目标等级序号：有等级表就读表做下拉（值=序号、显示「A（序号 10）」）；
      // 读不到退回数字输入（见上面 levels 的注释）
      levels.length
        ? {
            key: '目标等级序号',
            label: t('colTargetOrder'),
            width: '160px',
            form: true,
            type: 'select',
            required: true,
            options: levels.map((l) => l.value),
            selectLabels: Object.fromEntries(levels.map((l) => [l.value, l.label])),
            hint: t('hintTargetOrder'),
          }
        : {
            key: '目标等级序号',
            label: t('colTargetOrder'),
            width: '120px',
            form: true,
            type: 'number',
            required: true,
            hint: t('hintTargetOrderFallback'),
          },
      {
        key: '目标分',
        label: t('colTargetScore'),
        width: '100px',
        form: true,
        type: 'number',
        hint: t('hintTargetScore'),
      },
      { key: '备注', label: t('colDesc'), width: '160px', form: true, type: 'text' },
      {
        key: '更新时间',
        label: t('colUpdated'),
        width: '150px',
        render: (v) => <span className="muted">{formatDateTime(v)}</span>,
      },
    ],
    // levels 变了要重算：列的类型/候选都取决于等级表是否读到了
    [t, levels],
  );

  return (
    <CrudPage
      title={t('titleTargets')}
      subtitle={t('subtitleTargets')}
      columns={COLUMNS}
      moduleKey="markbookTargets"
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchTargets') }}
      extraLinks={[{ label: t('linkToMarkbook'), href: '/markbook' }]}
      api={{
        list: (p) => api.markbookTargets.list(p),
        create: (d) => api.markbookTargets.create(d),
        update: (id, d) => api.markbookTargets.update(id, d),
        archive: (id) => api.markbookTargets.archive(id),
      }}
    />
  );
}

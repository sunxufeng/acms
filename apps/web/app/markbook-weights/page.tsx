'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/date';

/**
 * 成绩类型权重（教学管理，2026-09-20 补页面）。
 *
 * 它是权重的**第二层**：某一行分数的权重 = `成绩册列.列权重` × 本表 `班级 × 考核类型` 的权重。
 * 第一层（列权重）在成绩册页每一列上填；本表用于「整类统一调」——
 * 比如让「期末」这类整体比「作业」重，不必逐列去改。
 *
 * 🔴 两个必须写在页面上的事实（否则会静默配错）：
 *  1. **实际匹配用的是「班级」文本**，不是「教学班」。服务端 `configsOf` 拿
 *     `normClass(权重.班级) === 成绩册当前班级` 匹配（班级 = 学生档案的「当前年级」）。
 *     只填「教学班」不填「班级」⇒ 权重**静默不生效**（算出来的总评看着就是没加权）。
 *  2. **不需要凑成 100**：汇总口径是「分母 = 实际参与项的权重和」（自归一化），
 *     所以只录了部分考核时也不会算错 —— 但把权重写成 40/30/20/10 更好读。
 */
export default function MarkbookWeightsPage() {
  const t = useTranslations('teaching');

  /**
   * 考核类型候选：读「考核类型」表（`/exam-types` 里已建的记录），**不是字典**。
   *
   * 为什么不放字典：权重是按类型名**等值匹配**的（服务端 `configsOf` 拿权重行的「类型」
   * 与成绩册列上的「考核类型」逐字比），两份名单必然漂移 ⇒ 改名后权重静默不生效。
   *
   * 走 `/markbook/type-options` 而不是 `/exam-types`：后者要 `module:examTypes:read`，
   * 配权重的老师通常只有成绩册权限 ⇒ 直连会 403、下拉空白（看着像「一个类型都没有」）。
   * 拉失败时不抛错，下拉为空但页面可用（与其它页面一致的降级）。
   */
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .markbookTypeOptions()
      .then((res) => {
        if (!alive) return;
        setTypeOptions(Array.isArray(res?.items) ? res.items : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const COLUMNS: CrudColumn[] = useMemo(
    () => [
      {
        key: '班级',
        label: t('colWeightClass'),
        width: '130px',
        // 改下拉后筛选也跟着变下拉（`dictKey` 会自动供筛选候选；原来 text + contains 是因为自由文本）
        filter: true,
        form: true,
        // 班级 = 学生档案的「当前年级」⇒ 候选取字典「当前年级」，与成绩册分组、学生档案同一份名单
        type: 'select',
        dictKey: '当前年级',
        required: true,
        hint: t('hintWeightClass'),
      },
      {
        key: '类型',
        label: t('colWeightType'),
        width: '130px',
        filter: true,
        filterOptions: typeOptions,
        form: true,
        // 候选项来自「考核类型」表（见上方注释）；不是自由文本，避免写法不一致导致权重不生效
        type: 'select',
        options: typeOptions,
        required: true,
        hint: t('hintWeightType'),
      },
      {
        key: '权重',
        label: t('colWeightValue'),
        width: '100px',
        form: true,
        type: 'number',
        required: true,
        hint: t('hintWeightValue'),
      },
      {
        key: '教学班',
        label: t('colTeachingClass'),
        width: '160px',
        form: true,
        type: 'link',
        // 只读：教学班目前还没有成员关系，这个字段不参与任何匹配（见文件头注释）。
        // 放开编辑只会让人以为「按教学班覆盖权重」已经生效。
        readonly: true,
        hint: t('hintTeachingClass'),
      },
      {
        key: '更新时间',
        label: t('colUpdated'),
        width: '150px',
        render: (v) => <span className="muted">{formatDateTime(v)}</span>,
      },
    ],
    [t, typeOptions],
  );

  return (
    <CrudPage
      title={t('titleWeights')}
      subtitle={t('subtitleWeights')}
      columns={COLUMNS}
      moduleKey="markbookWeights"
      inlineEdit
      standaloneForm
      search={{ placeholder: t('searchWeights') }}
      api={{
        list: (p) => api.markbookWeights.list(p),
        create: (d) => api.markbookWeights.create(d),
        update: (id, d) => api.markbookWeights.update(id, d),
        archive: (id) => api.markbookWeights.archive(id),
      }}
    />
  );
}

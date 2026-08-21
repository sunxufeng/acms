// @ts-nocheck
import { TABLES } from '@acms/contracts';

/** 一张表接入 AI 总结所需的配置 */
export interface AiSummarizeTableConfig {
  /** 路由前缀，例如 home-school-comms-ai */
  prefix: string;
  tableId: string;
  fieldAttach: string;
  fieldDetail: string;
  fieldSummary: string;
  fieldContent: string;
  /** 展示在提示词中的「基本信息」字段，按顺序列出 */
  metaFields: { label: string; key: string }[];
}

export const HOME_SCHOOL_COMMS_CONFIG: AiSummarizeTableConfig = {
  prefix: 'home-school-comms-ai',
  tableId: TABLES.homeSchoolComm.tableId,
  fieldAttach: '沟通附件清单',
  fieldDetail: '沟通明细',
  fieldSummary: '沟通总结',
  fieldContent: '沟通内容',
  metaFields: [
    { label: '关联学生', key: '关联学生' },
    { label: '家长', key: '家长' },
    { label: '沟通人', key: '沟通人' },
    { label: '沟通方式', key: '沟通方式' },
    { label: '沟通主题', key: '沟通主题' },
    { label: '沟通时间', key: '沟通时间' },
  ],
};

export const DAILY_FOLLOWUP_CONFIG: AiSummarizeTableConfig = {
  prefix: 'daily-followups-ai',
  tableId: TABLES.dailyFollowup.tableId,
  fieldAttach: '沟通附件清单',
  fieldDetail: '沟通明细',
  fieldSummary: '沟通总结',
  fieldContent: '沟通内容',
  metaFields: [
    { label: '关联学生', key: '关联学生' },
    { label: '沟通人', key: '沟通人' },
    { label: '沟通方式', key: '沟通方式' },
    { label: '沟通主题', key: '沟通主题' },
    { label: '沟通时间', key: '沟通时间' },
  ],
};

/** 登录页 / 主页配置（由「主页管理」编辑器维护） */

export interface LoginFeature {
  icon: 'shield' | 'users' | 'layers' | 'lock' | 'check' | 'zap' | string;
  title: string;
  desc: string;
}

export interface HomepageConfig {
  /** 左侧面板宽度百分比（0-100） */
  leftWidth: number;
  /** 右侧面板宽度百分比（0-100） */
  rightWidth: number;

  /** 左侧背景色 */
  leftBgColor: string;
  /** 左侧背景图：URL 或飞书 file_token */
  leftBgImage?: string | null;
  /** 左侧文字色 */
  leftTextColor: string;

  /** 右侧背景色 */
  rightBgColor: string;
  /** 右侧背景图：URL 或飞书 file_token */
  rightBgImage?: string | null;
  /** 右侧文字色 */
  rightTextColor: string;

  /** 左上角 Logo（URL 或 file_token），为空则显示品牌首字母 */
  logoUrl?: string | null;
  /** 品牌名 */
  brandName: string;
  /** 品牌副标题 */
  brandSubtitle: string;

  /** 主标题字体大小（CSS 值） */
  headingFontSize: string;
  /** 正文字体大小（CSS 值） */
  bodyFontSize: string;
  /** 字体族 */
  fontFamily: string;

  /** 左侧 eyebrow 小字 */
  eyebrow: string;
  /** 左侧 section label */
  sectionLabel: string;
  /** 左侧主标题（支持 \n 换行） */
  heroTitle: string;
  /** 左侧副标题 */
  heroSubtitle: string;
  /** 左侧特性列表 */
  features: LoginFeature[];

  /** 右侧小标签 */
  rightLabel: string;
  /** 右侧标题 */
  rightHeading: string;
  /** 右侧描述 */
  rightDesc: string;
  /** 登录按钮文字 */
  ctaText: string;
  /** 右下角状态标签 */
  statusTag: string;
  /** 右下角状态说明 */
  statusText: string;
}

/** 与当前设计稿一致的默认配置 */
export const DEFAULT_HOMEPAGE_CONFIG: HomepageConfig = {
  leftWidth: 40,
  rightWidth: 60,

  leftBgColor: '#0F2E2B',
  leftBgImage: null,
  leftTextColor: '#FFFFFF',

  rightBgColor: '#F4F7F6',
  rightBgImage: null,
  rightTextColor: '#111827',

  logoUrl: null,
  brandName: 'ARETE',
  brandSubtitle: 'COLLEGE MGMT',

  headingFontSize: 'clamp(32px, 4vw, 48px)',
  bodyFontSize: '14px',
  fontFamily:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',

  eyebrow: 'AUTH / 01',
  sectionLabel: 'IDENTITY GATEWAY',
  heroTitle: '学院运营\n从可信身份开始。',
  heroSubtitle:
    '身份、角色、校区和数据密级在进入工作台前完成校验。浏览器不会直接访问飞书 Base。',
  features: [
    { icon: 'shield', title: '身份来源', desc: 'Feishu Open ID' },
    { icon: 'layers', title: '授权模型', desc: 'RBAC + ABAC' },
    { icon: 'lock', title: '合规边界', desc: 'HttpOnly / S·H' },
  ],

  rightLabel: 'SECURE SIGN-IN / ARETE',
  rightHeading: '进入管理工作台',
  rightDesc:
    '飞书身份必须在「系统用户与角色表」中唯一、启用且处于有效期内；数据范围规则只会收敛角色权限。',
  ctaText: '使用飞书登录',
  statusTag: 'FAIL. CLOSED',
  statusText:
    '账户不存在、账号停用、授权过期、角色或密级超出许可时，系统将拒绝建立会话。',
};

/** 把图片字段值解析为可显示的 URL：
 *  - 以 http(s) 开头：直接返回
 *  - 其他值视为飞书 file_token，走公开图片代理 */
export function imageUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//.test(value)) return value;
  return `/api/v1/homepage-config/image/${encodeURIComponent(value)}`;
}

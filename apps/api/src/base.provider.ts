import { Provider } from '@nestjs/common';
import { BaseClient } from '@acms/base-adapter';

export const BASE_CLIENT = Symbol('BASE_CLIENT');

export const baseClientProvider: Provider = {
  provide: BASE_CLIENT,
  useFactory: (): BaseClient =>
    new BaseClient(
      {
        appId: process.env.FEISHU_APP_ID ?? '',
        appSecret: process.env.FEISHU_APP_SECRET ?? '',
      },
      process.env.FEISHU_BASE_TOKEN ?? '',
    ),
};

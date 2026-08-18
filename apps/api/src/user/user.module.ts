import { Module } from '@nestjs/common';
import { UsersController } from './user.controller.js';
import { UsersService } from './user.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, baseClientProvider],
})
export class UsersModule {}

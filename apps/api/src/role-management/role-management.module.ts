import { Module } from '@nestjs/common';
import { baseClientProvider } from '../base.provider.js';
import { RoleManagementController } from './role-management.controller.js';
import { RoleManagementService } from './role-management.service.js';

@Module({
  controllers: [RoleManagementController],
  providers: [RoleManagementService, baseClientProvider],
})
export class RoleManagementModule {}

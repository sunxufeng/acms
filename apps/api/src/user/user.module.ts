import { Module } from '@nestjs/common';
import { UsersController } from './user.controller.js';
import { UsersService } from './user.service.js';
import { baseClientProvider } from '../base.provider.js';
import { DepartmentModule } from '../department/department.module.js';

/**
 * 用户管理模块。
 *
 * 依赖 DepartmentModule：用户表本身没有部门字段，人与部门的关系只存在于
 * 部门成员快照（飞书同步落下）—— 用户管理页的「按部门筛选」与列表「部门」列
 * 都要站在那份快照上做（见 UsersService.list 的 departmentId 分支）。
 */
@Module({
  imports: [DepartmentModule],
  controllers: [UsersController],
  providers: [UsersService, baseClientProvider],
})
export class UsersModule {}

import { Module } from '@nestjs/common';
import { NoteArchiveController } from './note-archive.controller.js';
import { NoteArchiveService } from './note-archive.service.js';

/** 笔记归档到飞书云盘（每日 01:00 IDP / 01:30 全量） */
@Module({
  controllers: [NoteArchiveController],
  providers: [NoteArchiveService],
})
export class NoteArchiveModule {}

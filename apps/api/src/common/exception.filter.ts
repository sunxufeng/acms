import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

// 全局异常过滤器：把异常的真正信息透传给前端，避免被 Nest 默认 500「Internal Server Error」掩盖。
// - HttpException（BadRequest/Forbidden/NotFound 等）：沿用其状态码与消息。
// - 普通 Error（如 store 层抛出的校验错误）：以 500 + 真实 message 返回，便于前端提示用户。
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      message =
        typeof resp === 'string' ? resp : ((resp as any)?.message ?? exception.message);
    } else if (exception instanceof Error) {
      message = exception.message;
    } else {
      message = 'Internal server error';
    }
    if (!res.headersSent) {
      res.status(status).json({ statusCode: status, message });
    }
  }
}

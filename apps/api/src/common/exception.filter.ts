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
    /** 结构化附加字段，原样透传给前端 */
    const extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        message = resp;
      } else {
        const obj = (resp ?? {}) as Record<string, unknown>;
        message = (obj.message as string) ?? exception.message;
        // 业务错误码必须透传：同一种 HTTP 状态码可能对应完全不同的处理动作。
        // 例如「非会员」要引导开通、「Key 无效」要引导重填，光看 message 文案区分不了。
        // 只在调用方显式给了这些字段时才附加，既有错误的行为不受影响。
        for (const k of ['code', 'field', 'upstreamCode'] as const) {
          if (obj[k] !== undefined) extra[k] = obj[k];
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    } else {
      message = 'Internal server error';
    }
    if (!res.headersSent) {
      res.status(status).json({ statusCode: status, message, ...extra });
    }
  }
}

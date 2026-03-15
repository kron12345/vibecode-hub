import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global exception filter — catches all unhandled errors.
 * Logs the full error with stack trace and returns a clean JSON response.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Don't handle WebSocket contexts
    if (!response?.status) return;

    let status: number;
    let message: string;
    let error: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      message = typeof exResponse === 'string' ? exResponse : (exResponse as any).message || exception.message;
      error = exception.name;
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = exception.message;
      error = 'InternalServerError';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Unknown error';
      error = 'InternalServerError';
    }

    // Log the full error (including stack trace for 5xx)
    const logContext = {
      method: request.method,
      url: request.originalUrl,
      status,
      userAgent: request.get('user-agent'),
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} → ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
        JSON.stringify(logContext),
      );
    } else if (status >= 400 && status !== 401 && status !== 404) {
      // Skip 401/404 — too noisy
      this.logger.warn(
        `${request.method} ${request.originalUrl} → ${status}: ${message}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      error,
      message: Array.isArray(message) ? message : [message],
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    });
  }
}

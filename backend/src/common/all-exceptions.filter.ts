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
    let message: string;       // message for the client response
    let logMessage: string;    // detailed message for server logs only
    let error: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      const extractedMsg =
        typeof exResponse === 'string'
          ? exResponse
          : (exResponse as any).message || exception.message;
      // For 5xx HttpExceptions, also hide internal details from clients
      if (status >= 500) {
        message = 'Internal server error';
        logMessage = typeof extractedMsg === 'string'
          ? extractedMsg
          : JSON.stringify(extractedMsg);
      } else {
        message = extractedMsg;
        logMessage = typeof extractedMsg === 'string'
          ? extractedMsg
          : JSON.stringify(extractedMsg);
      }
      error = exception.name;
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      // Never expose internal error details to clients
      message = 'Internal server error';
      logMessage = exception.message;
      error = 'InternalServerError';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      logMessage = 'Unknown error';
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
        `${request.method} ${request.originalUrl} → ${status}: ${logMessage}`,
        exception instanceof Error ? exception.stack : undefined,
        JSON.stringify(logContext),
      );
    } else if (status >= 400 && status !== 401 && status !== 404) {
      // Skip 401/404 — too noisy
      this.logger.warn(
        `${request.method} ${request.originalUrl} → ${status}: ${logMessage}`,
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

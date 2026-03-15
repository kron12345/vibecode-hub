import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * HTTP Request/Response logging middleware.
 * Logs method, url, status code, and response time for every request.
 */
@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    const { method, originalUrl } = req;

    res.on('finish', () => {
      const duration = Date.now() - start;
      const { statusCode } = res;

      // Skip health checks and static assets from verbose logging
      if (originalUrl === '/api/health' || originalUrl.startsWith('/api/monitor/hardware')) {
        return;
      }

      const message = `${method} ${originalUrl} ${statusCode} ${duration}ms`;

      if (statusCode >= 500) {
        this.logger.error(message);
      } else if (statusCode >= 400) {
        this.logger.warn(message);
      } else {
        this.logger.log(message);
      }
    });

    next();
  }
}

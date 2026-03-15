import { WinstonModule, utilities as nestWinstonUtils } from 'nest-winston';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { join } from 'path';

const LOG_DIR = process.env.LOG_DIR || join(process.cwd(), '..', 'logs');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/** JSON format for file logs (machine-readable) */
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

/** Pretty format for console (human-readable) */
const consoleFormat = winston.format.combine(
  winston.format.timestamp(),
  nestWinstonUtils.format.nestLike('VibCode', {
    prettyPrint: true,
    colors: true,
  }),
);

export function createWinstonLogger() {
  return WinstonModule.createLogger({
    level: LOG_LEVEL,
    transports: [
      // Console output (same as NestJS default, but level-aware)
      new winston.transports.Console({
        format: consoleFormat,
      }),

      // Combined log file (all levels) — rotated daily, max 14 days
      new winston.transports.DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'vibcode-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '50m',
        maxFiles: '14d',
        format: jsonFormat,
      }),

      // Error log file (errors only) — rotated daily, max 30 days
      new winston.transports.DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'vibcode-error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '30d',
        level: 'error',
        format: jsonFormat,
      }),
    ],
  });
}

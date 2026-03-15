import { Injectable, Logger } from '@nestjs/common';

/**
 * Audit logging service — tracks who changed what and when.
 * Writes to a dedicated audit log file via the Winston logger.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger('Audit');

  /** Log a settings change */
  settingsChanged(category: string, key: string, userId?: string) {
    this.logger.log(
      `Settings changed: [${category}] ${key} by ${userId || 'system'}`,
    );
  }

  /** Log a project action */
  projectAction(action: string, projectId: string, userId?: string) {
    this.logger.log(
      `Project ${action}: ${projectId} by ${userId || 'system'}`,
    );
  }

  /** Log an agent action */
  agentAction(action: string, role: string, projectId: string) {
    this.logger.log(
      `Agent ${action}: ${role} on project ${projectId}`,
    );
  }

  /** Log an auth event */
  authEvent(event: string, userId?: string, detail?: string) {
    this.logger.log(
      `Auth ${event}: ${userId || 'unknown'} ${detail || ''}`.trim(),
    );
  }
}

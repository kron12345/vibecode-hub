import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SystemSettingsService } from '../settings/system-settings.service';
import { TelegramService } from './telegram.service';

/**
 * NotificationService — routes pipeline events to external notification channels.
 * Currently supports: Telegram. Extensible for Slack, email, push.
 *
 * Respects user preferences (which notification types to send).
 * Only sends to configured channels.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly settings: SystemSettingsService,
    private readonly telegram: TelegramService,
  ) {}

  @OnEvent('clarification.requested')
  async onClarificationRequested(payload: {
    chatSessionId: string;
    agentRole: string;
    question: string;
    options?: string[];
    issueId?: string;
    projectName?: string;
  }) {
    if (!this.shouldNotify('clarification')) return;

    let msg = `*${payload.agentRole} needs your input*`;
    if (payload.projectName) msg += ` (${payload.projectName})`;
    msg += `\n\n${payload.question}`;
    if (payload.options?.length) {
      msg += '\n\n*Options:*\n' + payload.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
    }
    msg += '\n\n_Reply in VibCode Hub to continue the pipeline._';

    await this.send(msg);
  }

  @OnEvent('notification.pipeline')
  async onPipelineEvent(payload: {
    type: 'completed' | 'failed' | 'needs_review';
    projectName: string;
    issueTitle?: string;
    message: string;
  }) {
    const notifType = payload.type === 'completed' ? 'result'
      : payload.type === 'failed' ? 'error' : 'result';

    if (!this.shouldNotify(notifType)) return;

    const icon = payload.type === 'completed' ? 'Done'
      : payload.type === 'failed' ? 'FAILED' : 'Needs Review';

    await this.send(`*[${icon}]* ${payload.projectName}\n${payload.message}`);
  }

  private shouldNotify(type: 'clarification' | 'result' | 'error' | 'status'): boolean {
    if (this.settings.get('notifications.telegram.notifyAll', '', 'false') === 'true') return true;
    const key = `notifications.telegram.notify${type.charAt(0).toUpperCase() + type.slice(1)}s`;
    const defaultVal = type === 'status' ? 'false' : 'true';
    return this.settings.get(key, '', defaultVal) === 'true';
  }

  private async send(message: string): Promise<void> {
    try {
      await this.telegram.sendNotification(message);
    } catch (err) {
      this.logger.warn(`Notification send failed: ${err.message}`);
    }
  }
}

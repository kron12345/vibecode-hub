import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SystemSettingsService } from '../settings/system-settings.service';

/**
 * NotificationService — sends notifications to external channels
 * when agents need user attention.
 *
 * Currently supports: (none — interface ready for Telegram, Slack, etc.)
 * Future: Telegram Bot, Slack, Email, Push Notifications
 *
 * Listens for 'clarificationRequired' events and routes them to
 * configured notification channels.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly settings: SystemSettingsService) {}

  /**
   * Send notification when an agent needs user input.
   * Routes to all configured channels (Telegram, etc.)
   */
  @OnEvent('clarification.requested')
  async onClarificationRequested(payload: {
    chatSessionId: string;
    agentRole: string;
    question: string;
    options?: string[];
    issueId?: string;
    projectName?: string;
  }) {
    const channels = this.getActiveChannels();
    if (channels.length === 0) return;

    const message = this.formatClarificationMessage(payload);

    for (const channel of channels) {
      try {
        await this.sendToChannel(channel, message);
      } catch (err) {
        this.logger.warn(
          `Failed to send notification via ${channel}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Send notification for pipeline completion or failure.
   */
  @OnEvent('notification.pipeline')
  async onPipelineEvent(payload: {
    type: 'completed' | 'failed' | 'needs_review';
    projectName: string;
    issueTitle?: string;
    message: string;
  }) {
    const channels = this.getActiveChannels();
    if (channels.length === 0) return;

    const prefix =
      payload.type === 'completed'
        ? 'Pipeline Complete'
        : payload.type === 'failed'
          ? 'Pipeline Failed'
          : 'Manual Review Needed';

    const message = `[${prefix}] ${payload.projectName}\n${payload.message}`;

    for (const channel of channels) {
      try {
        await this.sendToChannel(channel, message);
      } catch (err) {
        this.logger.warn(
          `Failed to send pipeline notification via ${channel}: ${err.message}`,
        );
      }
    }
  }

  private getActiveChannels(): string[] {
    const channels: string[] = [];

    // Telegram
    const telegramToken = this.settings.get(
      'notifications.telegram.botToken',
      '',
      '',
    );
    const telegramChatId = this.settings.get(
      'notifications.telegram.chatId',
      '',
      '',
    );
    if (telegramToken && telegramChatId) {
      channels.push('telegram');
    }

    return channels;
  }

  private async sendToChannel(channel: string, message: string) {
    switch (channel) {
      case 'telegram':
        return this.sendTelegram(message);
      default:
        this.logger.warn(`Unknown notification channel: ${channel}`);
    }
  }

  private async sendTelegram(message: string) {
    const token = this.settings.get(
      'notifications.telegram.botToken',
      '',
      '',
    );
    const chatId = this.settings.get(
      'notifications.telegram.chatId',
      '',
      '',
    );

    if (!token || !chatId) return;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API ${response.status}: ${body}`);
    }

    this.logger.debug(`Telegram notification sent to chat ${chatId}`);
  }

  private formatClarificationMessage(payload: {
    agentRole: string;
    question: string;
    options?: string[];
    projectName?: string;
  }): string {
    let msg = `*${payload.agentRole} needs your input*`;
    if (payload.projectName) {
      msg += ` (${payload.projectName})`;
    }
    msg += `\n\n${payload.question}`;

    if (payload.options && payload.options.length > 0) {
      msg += '\n\n*Options:*\n';
      payload.options.forEach((opt, i) => {
        msg += `${i + 1}. ${opt}\n`;
      });
    }

    msg += '\n_Reply in VibCode Hub to continue the pipeline._';
    return msg;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../settings/system-settings.service';
import { SettingsService } from '../settings/settings.service';

const TELEGRAM_API = 'https://api.telegram.org/bot';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly settings: SystemSettingsService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Validate a bot token by calling Telegram's getMe API.
   */
  async validateToken(token: string): Promise<{
    valid: boolean;
    botName?: string;
    botUsername?: string;
    error?: string;
  }> {
    try {
      const res = await fetch(`${TELEGRAM_API}${token}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      if (data.ok && data.result) {
        return {
          valid: true,
          botName: data.result.first_name,
          botUsername: data.result.username,
        };
      }
      return { valid: false, error: data.description ?? 'Invalid token' };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  /**
   * Auto-detect chat ID from the most recent message sent to the bot.
   * User should send a message to the bot first, then call this.
   */
  async detectChatId(token: string): Promise<{
    found: boolean;
    chatId?: string;
    firstName?: string;
    username?: string;
    error?: string;
  }> {
    try {
      const res = await fetch(`${TELEGRAM_API}${token}/getUpdates?limit=5&timeout=0`, {
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      if (!data.ok || !data.result?.length) {
        return { found: false, error: 'No messages found. Please send a message to your bot first.' };
      }

      // Get the most recent message with a chat
      const latest = data.result
        .reverse()
        .find((u: any) => u.message?.chat?.id);

      if (!latest) {
        return { found: false, error: 'No messages with chat data found.' };
      }

      const chat = latest.message.chat;
      return {
        found: true,
        chatId: String(chat.id),
        firstName: chat.first_name,
        username: chat.username,
      };
    } catch (err) {
      return { found: false, error: err.message };
    }
  }

  /**
   * Send a test message to verify the bot can reach the user.
   */
  async sendTestMessage(
    token: string,
    chatId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: 'VibCode Hub connected! You will receive pipeline notifications here.',
          parse_mode: 'Markdown',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      if (data.ok) return { success: true };
      return { success: false, error: data.description ?? 'Send failed' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Save Telegram config to encrypted system settings.
   */
  async saveConfig(config: {
    botToken: string;
    chatId: string;
    notifyClarifications?: boolean;
    notifyResults?: boolean;
    notifyErrors?: boolean;
    notifyStatus?: boolean;
    notifyAll?: boolean;
  }): Promise<{ saved: boolean }> {
    const settings = [
      { key: 'notifications.telegram.botToken', value: config.botToken, category: 'notifications', encrypted: true },
      { key: 'notifications.telegram.chatId', value: config.chatId, category: 'notifications', encrypted: false },
      { key: 'notifications.telegram.notifyClarifications', value: String(config.notifyClarifications ?? true), category: 'notifications' },
      { key: 'notifications.telegram.notifyResults', value: String(config.notifyResults ?? true), category: 'notifications' },
      { key: 'notifications.telegram.notifyErrors', value: String(config.notifyErrors ?? true), category: 'notifications' },
      { key: 'notifications.telegram.notifyStatus', value: String(config.notifyStatus ?? false), category: 'notifications' },
      { key: 'notifications.telegram.notifyAll', value: String(config.notifyAll ?? false), category: 'notifications' },
    ];

    await this.settingsService.bulkUpsertSystemSettings(settings);
    await this.settings.refreshCache();

    this.logger.log(`Telegram config saved (chat ${config.chatId})`);
    return { saved: true };
  }

  /**
   * Get current Telegram configuration (token masked).
   */
  async getConfig(): Promise<{
    configured: boolean;
    botToken?: string;
    chatId?: string;
    notifyClarifications: boolean;
    notifyResults: boolean;
    notifyErrors: boolean;
    notifyStatus: boolean;
    notifyAll: boolean;
  }> {
    const token = this.settings.get('notifications.telegram.botToken', '', '');
    const chatId = this.settings.get('notifications.telegram.chatId', '', '');

    return {
      configured: !!(token && chatId),
      botToken: token ? `${token.substring(0, 8)}...${token.slice(-4)}` : undefined,
      chatId: chatId || undefined,
      notifyClarifications:
        this.settings.get('notifications.telegram.notifyClarifications', '', 'true') === 'true',
      notifyResults:
        this.settings.get('notifications.telegram.notifyResults', '', 'true') === 'true',
      notifyErrors:
        this.settings.get('notifications.telegram.notifyErrors', '', 'true') === 'true',
      notifyStatus:
        this.settings.get('notifications.telegram.notifyStatus', '', 'false') === 'true',
      notifyAll:
        this.settings.get('notifications.telegram.notifyAll', '', 'false') === 'true',
    };
  }

  /**
   * Send a notification (called by NotificationService).
   * Only sends if chat ID matches configured ID (security: ignore other users).
   */
  async sendNotification(message: string): Promise<boolean> {
    const token = this.settings.get('notifications.telegram.botToken', '', '');
    const chatId = this.settings.get('notifications.telegram.chatId', '', '');
    if (!token || !chatId) return false;

    try {
      const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return data.ok === true;
    } catch (err) {
      this.logger.warn(`Telegram send failed: ${err.message}`);
      return false;
    }
  }
}

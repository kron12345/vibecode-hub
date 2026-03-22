import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { NotificationService } from './notification.service';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [SettingsModule],
  controllers: [TelegramController],
  providers: [NotificationService, TelegramService],
  exports: [NotificationService, TelegramService],
})
export class NotificationModule {}

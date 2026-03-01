import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SystemSettingsService } from './system-settings.service';
import { SettingsController } from './settings.controller';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, SystemSettingsService],
  exports: [SettingsService, SystemSettingsService],
})
export class SettingsModule {}

import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SystemSettingsService } from './system-settings.service';
import { ProviderDiscoveryService } from './provider-discovery.service';
import { SettingsController } from './settings.controller';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, SystemSettingsService, ProviderDiscoveryService],
  exports: [SettingsService, SystemSettingsService, ProviderDiscoveryService],
})
export class SettingsModule {}

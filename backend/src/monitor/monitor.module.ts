import { Module } from '@nestjs/common';
import { HardwareService } from './hardware.service';
import { MonitorGateway } from './monitor.gateway';
import { MonitorController } from './monitor.controller';

@Module({
  controllers: [MonitorController],
  providers: [HardwareService, MonitorGateway],
  exports: [MonitorGateway, HardwareService],
})
export class MonitorModule {}

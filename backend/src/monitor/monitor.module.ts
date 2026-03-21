import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HardwareService } from './hardware.service';
import { MonitorGateway } from './monitor.gateway';
import { MonitorController } from './monitor.controller';

@Module({
  imports: [AuthModule],
  controllers: [MonitorController],
  providers: [HardwareService, MonitorGateway],
  exports: [MonitorGateway, HardwareService],
})
export class MonitorModule {}

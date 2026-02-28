import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GitlabService } from './gitlab.service';
import { GitlabController } from './gitlab.controller';

@Module({
  imports: [HttpModule],
  controllers: [GitlabController],
  providers: [GitlabService],
  exports: [GitlabService],
})
export class GitlabModule {}

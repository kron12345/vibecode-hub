import { Module } from '@nestjs/common';
import { IssuesService } from './issues.service';
import { IssuesController, MilestonesController } from './issues.controller';
import { GitlabModule } from '../gitlab/gitlab.module';

@Module({
  imports: [GitlabModule],
  controllers: [IssuesController, MilestonesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}

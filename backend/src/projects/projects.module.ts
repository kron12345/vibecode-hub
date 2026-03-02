import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { GitlabModule } from '../gitlab/gitlab.module';
import { AgentsModule } from '../agents/agents.module';
import { PreviewModule } from '../preview/preview.module';

@Module({
  imports: [GitlabModule, AgentsModule, PreviewModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}

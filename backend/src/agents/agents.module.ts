import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { PreviewModule } from '../preview/preview.module';
import { GitlabModule } from '../gitlab/gitlab.module';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentsController } from './agents.controller';
import { InterviewerAgent } from './interviewer/interviewer.agent';
import { DevopsAgent } from './devops/devops.agent';

@Module({
  imports: [ChatModule, PreviewModule, GitlabModule],
  controllers: [AgentsController],
  providers: [AgentOrchestratorService, InterviewerAgent, DevopsAgent],
  exports: [AgentOrchestratorService],
})
export class AgentsModule {}

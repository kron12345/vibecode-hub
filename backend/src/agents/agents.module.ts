import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentsController } from './agents.controller';
import { InterviewerAgent } from './interviewer/interviewer.agent';

@Module({
  imports: [ChatModule],
  controllers: [AgentsController],
  providers: [AgentOrchestratorService, InterviewerAgent],
  exports: [AgentOrchestratorService],
})
export class AgentsModule {}

import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { PreviewModule } from '../preview/preview.module';
import { GitlabModule } from '../gitlab/gitlab.module';
import { IssuesModule } from '../issues/issues.module';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentsController } from './agents.controller';
import { InterviewerAgent } from './interviewer/interviewer.agent';
import { DevopsAgent } from './devops/devops.agent';
import { ArchitectAgent } from './architect/architect.agent';
import { IssueCompilerAgent } from './issue-compiler/issue-compiler.agent';
import { CoderAgent } from './coder/coder.agent';
import { CodeReviewerAgent } from './code-reviewer/code-reviewer.agent';
import { FunctionalTesterAgent } from './functional-tester/functional-tester.agent';
import { UiTesterAgent } from './ui-tester/ui-tester.agent';
import { PenTesterAgent } from './pen-tester/pen-tester.agent';
import { DocumenterAgent } from './documenter/documenter.agent';

@Module({
  imports: [ChatModule, PreviewModule, GitlabModule, IssuesModule],
  controllers: [AgentsController],
  providers: [
    AgentOrchestratorService,
    InterviewerAgent,
    DevopsAgent,
    ArchitectAgent,
    IssueCompilerAgent,
    CoderAgent,
    CodeReviewerAgent,
    FunctionalTesterAgent,
    UiTesterAgent,
    PenTesterAgent,
    DocumenterAgent,
  ],
  exports: [AgentOrchestratorService],
})
export class AgentsModule {}

import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { IsString, MinLength, MaxLength } from 'class-validator';

export class StartInterviewDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  projectId: string;
}

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly orchestrator: AgentOrchestratorService) {}

  @Post('interview/start')
  startInterview(@Body() dto: StartInterviewDto) {
    return this.orchestrator.startInterview(dto.projectId);
  }

  @Get('status/:projectId')
  getStatus(@Param('projectId') projectId: string) {
    return this.orchestrator.getProjectAgentStatus(projectId);
  }
}

import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { IsString, IsNumber, MinLength, MaxLength, IsOptional } from 'class-validator';

export class StartInterviewDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  projectId: string;
}

export class StartCodingDto {
  @IsString()
  @MinLength(1)
  projectId: string;

  @IsString()
  @MinLength(1)
  chatSessionId: string;
}

export class StartReviewDto {
  @IsString()
  @MinLength(1)
  projectId: string;

  @IsString()
  @MinLength(1)
  chatSessionId: string;

  @IsString()
  @MinLength(1)
  issueId: string;

  @IsNumber()
  mrIid: number;

  @IsNumber()
  gitlabProjectId: number;
}

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly orchestrator: AgentOrchestratorService) {}

  @Post('interview/start')
  startInterview(@Body() dto: StartInterviewDto) {
    return this.orchestrator.startInterview(dto.projectId);
  }

  @Post('coding/start')
  startCoding(@Body() dto: StartCodingDto) {
    return this.orchestrator.startCoding(dto.projectId, dto.chatSessionId);
  }

  @Post('review/start')
  startReview(@Body() dto: StartReviewDto) {
    return this.orchestrator.startCodeReview(
      dto.projectId, dto.chatSessionId, dto.issueId, dto.mrIid, dto.gitlabProjectId,
    );
  }

  @Get('status/:projectId')
  getStatus(@Param('projectId') projectId: string) {
    return this.orchestrator.getProjectAgentStatus(projectId);
  }
}

import { Controller, Post, Get, Body, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import {
  IsString,
  IsNumber,
  MinLength,
  MaxLength,
  IsOptional,
} from 'class-validator';

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

export class StartTestDto {
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

export class PipelineFailureQueryDto {
  @IsString()
  @MinLength(1)
  projectId: string;

  @IsString()
  @MinLength(1)
  chatSessionId: string;
}

export class ResumePipelineDto {
  @IsString()
  @MinLength(1)
  projectId: string;

  @IsString()
  @MinLength(1)
  chatSessionId: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  failedTaskId?: string;
}

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly orchestrator: AgentOrchestratorService) {}

  @Post('interview/start')
  startInterview(@Body() dto: StartInterviewDto) {
    return this.orchestrator.startInterview(dto.projectId);
  }

  @Post('devops/start')
  startDevops(@Body() dto: StartCodingDto) {
    return this.orchestrator.startDevopsSetup(dto.projectId, dto.chatSessionId);
  }

  @Post('architect/start')
  startArchitect(@Body() dto: StartCodingDto) {
    return this.orchestrator.startArchitectDesign(
      dto.projectId,
      dto.chatSessionId,
    );
  }

  @Post('issue-compiler/start')
  startIssueCompiler(@Body() dto: StartCodingDto) {
    return this.orchestrator.startIssueCompilation(
      dto.projectId,
      dto.chatSessionId,
    );
  }

  @Post('coding/start')
  startCoding(@Body() dto: StartCodingDto) {
    return this.orchestrator.startCoding(dto.projectId, dto.chatSessionId);
  }

  @Post('review/start')
  startReview(@Body() dto: StartReviewDto) {
    return this.orchestrator.startCodeReview(
      dto.projectId,
      dto.chatSessionId,
      dto.issueId,
      dto.mrIid,
      dto.gitlabProjectId,
    );
  }

  @Post('functional-test/start')
  startFunctionalTest(@Body() dto: StartTestDto) {
    return this.orchestrator.startFunctionalTest(
      dto.projectId,
      dto.chatSessionId,
      dto.issueId,
      dto.mrIid,
      dto.gitlabProjectId,
    );
  }

  @Post('ui-test/start')
  startUiTest(@Body() dto: StartTestDto) {
    return this.orchestrator.startUiTest(
      dto.projectId,
      dto.chatSessionId,
      dto.issueId,
      dto.mrIid,
      dto.gitlabProjectId,
    );
  }

  @Post('pen-test/start')
  startPenTest(@Body() dto: StartTestDto) {
    return this.orchestrator.startPenTest(
      dto.projectId,
      dto.chatSessionId,
      dto.issueId,
      dto.mrIid,
      dto.gitlabProjectId,
    );
  }

  @Post('docs/start')
  startDocs(@Body() dto: StartTestDto) {
    return this.orchestrator.startDocumenter(
      dto.projectId,
      dto.chatSessionId,
      dto.issueId,
      dto.mrIid,
      dto.gitlabProjectId,
    );
  }

  @Get('status/:projectId')
  getStatus(@Param('projectId') projectId: string) {
    return this.orchestrator.getProjectAgentStatus(projectId);
  }

  @Get('pipeline/latest-failure')
  getLatestPipelineFailure(@Query() dto: PipelineFailureQueryDto) {
    return this.orchestrator.getLatestPipelineFailure(
      dto.projectId,
      dto.chatSessionId,
    );
  }

  @Post('pipeline/resume')
  resumePipeline(@Body() dto: ResumePipelineDto) {
    return this.orchestrator.resumePipelineFromFailedTask(
      dto.projectId,
      dto.chatSessionId,
      dto.failedTaskId,
    );
  }
}

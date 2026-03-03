import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiQuery } from '@nestjs/swagger';
import { IssuesService } from './issues.service';
import { CreateIssueDto, UpdateIssueDto } from './issues.dto';

@ApiTags('milestones')
@Controller('milestones')
export class MilestonesController {
  constructor(private readonly issuesService: IssuesService) {}

  @Get()
  @ApiQuery({ name: 'projectId', required: true })
  findByProject(@Query('projectId') projectId: string) {
    return this.issuesService.findMilestonesByProject(projectId);
  }
}

@ApiTags('issues')
@Controller('issues')
export class IssuesController {
  constructor(private readonly issuesService: IssuesService) {}

  @Get()
  @ApiQuery({ name: 'projectId', required: true })
  findByProject(@Query('projectId') projectId: string) {
    return this.issuesService.findByProject(projectId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.issuesService.findById(id);
  }

  @Post()
  create(@Body() dto: CreateIssueDto) {
    return this.issuesService.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateIssueDto) {
    return this.issuesService.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.issuesService.delete(id);
  }
}

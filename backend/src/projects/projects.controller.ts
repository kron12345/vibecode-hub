import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import {
  CreateProjectDto,
  CreateMinimalProjectDto,
  UpdateProjectDto,
} from './projects.dto';
import { AgentOrchestratorService } from '../agents/agent-orchestrator.service';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly orchestrator: AgentOrchestratorService,
  ) {}

  @Get()
  findAll() {
    return this.projectsService.findAll();
  }

  @Get(':slug')
  async findBySlug(@Param('slug') slug: string) {
    const project = await this.projectsService.findBySlug(slug);
    if (!project) throw new NotFoundException(`Project "${slug}" not found`);
    return project;
  }

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.projectsService.create(dto);
  }

  /** Quick-create: name only → auto interview */
  @Post('quick')
  async quickCreate(@Body() dto: CreateMinimalProjectDto) {
    const project = await this.projectsService.createMinimal(dto.name);
    const interview = await this.orchestrator.startInterview(project.id);
    return { project, interview };
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.projectsService.delete(id);
  }
}

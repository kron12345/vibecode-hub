import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { CreateProjectDto, UpdateProjectDto } from './projects.dto';
import { ProjectStatus } from '@prisma/client';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private prisma: PrismaService,
    private gitlab: GitlabService,
  ) {}

  findAll() {
    return this.prisma.project.findMany({
      orderBy: { updatedAt: 'desc' },
    });
  }

  findBySlug(slug: string) {
    return this.prisma.project.findUnique({
      where: { slug },
      include: {
        issues: { where: { parentId: null }, orderBy: { createdAt: 'desc' } },
        agents: true,
      },
    });
  }

  findById(id: string) {
    return this.prisma.project.findUnique({
      where: { id },
      include: { issues: true, agents: true },
    });
  }

  async create(dto: CreateProjectDto) {
    // Create GitLab repo if no gitlabProjectId is provided
    if (!dto.gitlabProjectId) {
      try {
        const glProject = await this.gitlab.createProject({
          name: dto.name,
          path: dto.slug,
          description: dto.description,
        });
        dto.gitlabProjectId = glProject.id;
        dto.gitlabUrl = glProject.web_url;
        this.logger.log(`GitLab repo created: ${glProject.web_url}`);
      } catch (err) {
        this.logger.warn(`Could not create GitLab repo: ${err.message}`);
        // Project still gets created locally, just without GitLab link
      }
    }

    return this.prisma.project.create({ data: dto });
  }

  update(id: string, dto: UpdateProjectDto) {
    return this.prisma.project.update({ where: { id }, data: dto });
  }

  /** Create a minimal project (name only) for the interview flow */
  async createMinimal(name: string) {
    // Generate slug from name
    let slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Ensure slug is at least 2 chars
    if (slug.length < 2) {
      slug = `project-${slug || Date.now()}`;
    }

    // Check for slug collision and append suffix if needed
    const existing = await this.prisma.project.findUnique({
      where: { slug },
    });
    if (existing) {
      slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    }

    return this.prisma.project.create({
      data: {
        name,
        slug,
        status: ProjectStatus.INTERVIEWING,
      },
    });
  }

  async delete(id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });

    if (project?.gitlabProjectId) {
      try {
        await this.gitlab.deleteProject(project.gitlabProjectId);
        this.logger.log(`GitLab repo deleted: ID ${project.gitlabProjectId}`);
      } catch (err) {
        this.logger.warn(`Could not delete GitLab repo: ${err.message}`);
      }
    }

    return this.prisma.project.delete({ where: { id } });
  }
}

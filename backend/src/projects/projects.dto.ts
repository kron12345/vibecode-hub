import {
  IsString,
  IsOptional,
  IsInt,
  IsEnum,
  IsBoolean,
  IsArray,
  Matches,
  MinLength,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectStatus } from '@prisma/client';

export class CreateProjectDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ description: 'URL-safe slug (a-z, 0-9, hyphens)' })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  slug: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  gitlabProjectId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  gitlabUrl?: string;
}

export class CreateMinimalProjectDto {
  @ApiProperty({ description: 'Project name — slug is auto-generated' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;
}

// ─── Nested DTOs for techStack deep-merge ──────────────────

export class TechStackInfoDto {
  @IsOptional()
  @IsString()
  framework?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  backend?: string;

  @IsOptional()
  @IsString()
  database?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  additional?: string[];
}

export class DeploymentInfoDto {
  @IsOptional()
  @IsBoolean()
  isWebProject?: boolean;

  @IsOptional()
  @IsInt()
  devServerPort?: number;

  @IsOptional()
  @IsString()
  devServerCommand?: string;

  @IsOptional()
  @IsString()
  buildCommand?: string;
}

export class SetupInstructionsDto {
  @IsOptional()
  @IsString()
  initCommand?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  additionalCommands?: string[];
}

export class TechStackUpdateDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TechStackInfoDto)
  techStack?: TechStackInfoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeploymentInfoDto)
  deployment?: DeploymentInfoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SetupInstructionsDto)
  setupInstructions?: SetupInstructionsDto;
}

// ─── Main Update DTO ───────────────────────────────────────

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiProperty({
    required: false,
    description:
      'Base branch for feature branches (e.g. "develop"). Null = GitLab default.',
  })
  @IsOptional()
  @IsString()
  workBranch?: string | null;

  @ApiProperty({
    required: false,
    description:
      'Override global maxFixAttempts per project. Null = use global setting.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxFixAttempts?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => TechStackUpdateDto)
  techStack?: TechStackUpdateDto;
}

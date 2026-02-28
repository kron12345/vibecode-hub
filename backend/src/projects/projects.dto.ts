import { IsString, IsOptional, IsInt, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  gitlabProjectId?: number;

  @IsOptional()
  @IsString()
  gitlabUrl?: string;
}

import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsInt,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IssueStatus, IssuePriority, CommentAuthorType } from '@prisma/client';

export class CreateIssueDto {
  @ApiProperty()
  @IsString()
  projectId: string;

  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: IssuePriority, default: IssuePriority.MEDIUM, required: false })
  @IsOptional()
  @IsEnum(IssuePriority)
  priority?: IssuePriority;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @ApiProperty({ required: false, description: 'Parent issue ID for sub-issues' })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiProperty({ required: false, description: 'Milestone ID to assign this issue to' })
  @IsOptional()
  @IsString()
  milestoneId?: string;

  @ApiProperty({ required: false, description: 'GitLab milestone ID for issue sync' })
  @IsOptional()
  @IsInt()
  gitlabMilestoneId?: number;

  @ApiProperty({ required: false, description: 'Sort order within milestone (lower = first)' })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiProperty({ required: false, description: 'Sync to GitLab on creation' })
  @IsOptional()
  syncToGitlab?: boolean;
}

export class UpdateIssueDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: IssueStatus, required: false })
  @IsOptional()
  @IsEnum(IssueStatus)
  status?: IssueStatus;

  @ApiProperty({ enum: IssuePriority, required: false })
  @IsOptional()
  @IsEnum(IssuePriority)
  priority?: IssuePriority;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  assignedAgentId?: string;
}

export class CreateIssueCommentDto {
  @ApiProperty({ description: 'Comment content' })
  @IsString()
  content: string;

  @ApiProperty({ enum: CommentAuthorType, default: CommentAuthorType.USER, required: false })
  @IsOptional()
  @IsEnum(CommentAuthorType)
  authorType?: CommentAuthorType;

  @ApiProperty({ required: false, description: 'Author display name' })
  @IsOptional()
  @IsString()
  authorName?: string;

  @ApiProperty({ required: false, default: false, description: 'Also post as GitLab note' })
  @IsOptional()
  @IsBoolean()
  syncToGitlab?: boolean;
}

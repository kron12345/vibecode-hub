import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsArray,
  IsEnum,
  IsObject,
} from 'class-validator';
import { AgentRole } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateMcpServerDto {
  @ApiProperty({ example: 'git' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Git Server' })
  @IsString()
  @IsNotEmpty()
  displayName: string;

  @ApiPropertyOptional({
    example: 'Git operations: branch, commit, diff, merge',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: 'coding',
    enum: ['coding', 'execution', 'security', 'knowledge', 'custom'],
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ example: 'npx' })
  @IsString()
  @IsNotEmpty()
  command: string;

  @ApiProperty({ example: ['@modelcontextprotocol/server-git'] })
  @IsArray()
  @IsString({ each: true })
  args: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @ApiPropertyOptional({ example: '{workspace}' })
  @IsOptional()
  @IsString()
  argTemplate?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateMcpServerDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  command?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  args?: string[];

  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @IsOptional()
  @IsString()
  argTemplate?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SetRoleAssignmentsDto {
  @ApiProperty({
    example: ['CODER', 'CODE_REVIEWER'],
    enum: AgentRole,
    isArray: true,
  })
  @IsArray()
  @IsEnum(AgentRole, { each: true })
  roles: AgentRole[];
}

export class SetProjectOverrideDto {
  @ApiProperty({ example: 'cm...serverId' })
  @IsString()
  @IsNotEmpty()
  mcpServerId: string;

  @ApiProperty({ example: 'CODER', enum: AgentRole })
  @IsEnum(AgentRole)
  agentRole: AgentRole;

  @ApiProperty({ example: 'DISABLE', enum: ['ENABLE', 'DISABLE'] })
  @IsString()
  @IsNotEmpty()
  action: 'ENABLE' | 'DISABLE';
}

export class DeleteProjectOverrideDto {
  @ApiProperty({ example: 'cm...serverId' })
  @IsString()
  @IsNotEmpty()
  mcpServerId: string;

  @ApiProperty({ example: 'CODER', enum: AgentRole })
  @IsEnum(AgentRole)
  agentRole: AgentRole;
}

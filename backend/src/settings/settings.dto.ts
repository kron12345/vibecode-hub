import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── User Settings ──────────────────────────────────────────

export class UpsertUserSettingDto {
  @ApiProperty({ example: 'theme' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ example: '"dark"' })
  @IsString()
  value: string;
}

export class BulkUpsertUserSettingsDto {
  @ApiProperty({ type: [UpsertUserSettingDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsertUserSettingDto)
  settings: UpsertUserSettingDto[];
}

// ─── System Settings ────────────────────────────────────────

export class UpsertSystemSettingDto {
  @ApiProperty({ example: 'gitlab.url' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ example: '"https://git.example.com"' })
  @IsString()
  value: string;

  @ApiPropertyOptional({ example: 'gitlab' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  encrypted?: boolean;

  @ApiPropertyOptional({ example: 'GitLab server URL' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class BulkUpsertSystemSettingsDto {
  @ApiProperty({ type: [UpsertSystemSettingDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsertSystemSettingDto)
  settings: UpsertSystemSettingDto[];
}

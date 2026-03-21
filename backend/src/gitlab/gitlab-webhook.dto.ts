import { IsString, IsOptional, IsObject, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Minimal DTO for GitLab webhook object_attributes.
 * GitLab payloads are highly variable, so we only validate
 * the fields we actually use for routing and identification.
 */
class WebhookObjectAttributes {
  @IsOptional()
  @IsInt()
  id?: number;

  @IsOptional()
  @IsInt()
  iid?: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  ref?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  noteable_type?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  body?: string;
}

class WebhookProject {
  @IsInt()
  id: number;
}

/**
 * GitLab Webhook payload DTO.
 * Validates the required top-level structure while allowing
 * the variable nested data to pass through.
 */
export class GitlabWebhookDto {
  @IsString()
  object_kind: string;

  @IsOptional()
  @IsObject()
  @Type(() => WebhookObjectAttributes)
  object_attributes?: WebhookObjectAttributes;

  @IsOptional()
  @IsObject()
  @Type(() => WebhookProject)
  project?: WebhookProject;

  @IsOptional()
  @IsObject()
  user?: Record<string, any>;

  @IsOptional()
  @IsObject()
  issue?: Record<string, any>;

  /** Labels array — variable structure, passed through */
  @IsOptional()
  labels?: any[];
}

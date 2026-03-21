/**
 * GitlabService — Thin facade that composes all GitLab sub-services
 * via an inheritance chain. External code imports only this file.
 *
 * Inheritance chain:
 *   GitlabCoreService (HTTP helpers, projects, branches, repo, members, webhooks, uploads)
 *     → GitlabIssuesService (issues, labels, milestones, notes, work items)
 *       → GitlabWikiService (wiki CRUD)
 *         → GitlabMrService (merge requests, diffs, discussions, pipelines, jobs)
 *           → GitlabService (NestJS @Injectable facade)
 */
import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SystemSettingsService } from '../settings/system-settings.service';
import { GitlabMrService } from './gitlab-mr.service';

// Re-export all interfaces so external imports from './gitlab.service' keep working
export type {
  GitLabProject,
  GitLabIssue,
  GitLabMilestone,
  GitLabNote,
  GitLabMergeRequest,
  GitLabDiscussionNote,
  GitLabDiscussion,
  MrDiscussionPosition,
  GitLabMrDiff,
  GitLabPipeline,
  GitLabJob,
  GitLabBranch,
  GitLabTreeItem,
  GitLabWikiPage,
  GitLabWorkItem,
  CreateProjectOptions,
  CreateIssueOptions,
  UpdateIssueOptions,
  CreateMergeRequestOptions,
  CreateMilestoneOptions,
  UpdateMilestoneOptions,
} from './gitlab.interfaces';

@Injectable()
export class GitlabService extends GitlabMrService {
  constructor(httpService: HttpService, systemSettings: SystemSettingsService) {
    super(httpService, systemSettings);
  }
}

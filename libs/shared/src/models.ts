import type {
  ProjectStatus,
  IssueStatus,
  IssuePriority,
  CommentAuthorType,
  ChatSessionType,
  SessionStatus,
  MessageRole,
  MessageVisibility,
  AgentRole,
  AgentStatus,
} from './enums';

// ─── Project ──────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  status?: ProjectStatus;
  techStack?: Record<string, unknown> | null;
  gitlabProjectId?: number | null;
  gitlabUrl?: string | null;
  workBranch?: string | null;
  previewPort?: number | null;
  createdAt: string;
  updatedAt: string;
  issues?: Issue[];
  agents?: AgentInstance[];
}

export interface UpdateProjectPayload {
  name?: string;
  description?: string;
  workBranch?: string | null;
  maxFixAttempts?: number | null;
  status?: ProjectStatus;
  techStack?: {
    techStack?: {
      framework?: string;
      language?: string;
      backend?: string;
      database?: string;
      additional?: string[];
    };
    deployment?: {
      isWebProject?: boolean;
      devServerPort?: number;
      devServerCommand?: string;
      buildCommand?: string;
    };
    setupInstructions?: {
      initCommand?: string;
      additionalCommands?: string[];
    };
  };
}

export interface QuickCreateResult {
  project: Project;
  interview: {
    agentInstanceId: string;
    agentTaskId: string;
    chatSessionId: string;
  };
}

// ─── Milestone ────────────────────────────────────────────────

export interface Milestone {
  id: string;
  projectId: string;
  gitlabMilestoneId?: number | null;
  title: string;
  description?: string | null;
  sortOrder: number;
  startDate?: string | null;
  dueDate?: string | null;
  issues?: Pick<Issue, 'id' | 'title' | 'status' | 'priority'>[];
  createdAt: string;
  updatedAt: string;
}

// ─── Issue ────────────────────────────────────────────────────

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  labels: string[];
  parentId?: string | null;
  milestoneId?: string | null;
  milestone?: { id: string; title: string; sortOrder: number } | null;
  subIssues?: Issue[];
  gitlabIid?: number | null;
  assignedAgent?: { id: string; role: AgentRole; status: AgentStatus } | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: string;
  issueId: string;
  gitlabNoteId?: number | null;
  authorType: CommentAuthorType;
  authorName: string;
  content: string;
  agentTaskId?: string | null;
  createdAt: string;
}

// ─── Chat ─────────────────────────────────────────────────────

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  type: ChatSessionType;
  status: SessionStatus;
  branch?: string | null;
  archivedAt?: string | null;
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
  _count?: { issues: number };
}

export interface ChatMessage {
  id: string;
  chatSessionId: string;
  role: MessageRole;
  content: string;
  visibility?: MessageVisibility;
  issueId?: string | null;
  agentTaskId?: string | null;
  createdAt: string;
}

// ─── Agent ────────────────────────────────────────────────────

export interface AgentInstance {
  id: string;
  role: AgentRole;
  provider: string;
  model: string;
  status: AgentStatus;
}

// ─── Pipeline ─────────────────────────────────────────────────

export interface PipelineFailureSummary {
  taskId: string;
  taskType: string;
  agentRole: string;
  issueId?: string | null;
  issueTitle?: string | null;
  issueGitlabIid?: number | null;
  gitlabMrIid?: number | null;
  failedAt: string;
  reason: string;
}

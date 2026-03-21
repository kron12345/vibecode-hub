import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

// Re-export shared types so existing imports from this file continue to work
export type {
  ProjectStatus,
  ChatSessionType,
  SessionStatus,
  IssueStatus,
  IssuePriority,
  CommentAuthorType,
  MessageRole,
  DualTestStrategy,
} from '@vibcode/shared';

export type {
  Project,
  UpdateProjectPayload,
  QuickCreateResult,
  Milestone,
  Issue,
  IssueComment,
  ChatSession,
  ChatMessage,
  AgentInstance,
  PipelineFailureSummary,
} from '@vibcode/shared';

export type {
  SystemSetting,
  UserSettings,
  AgentRoleConfig,
  AgentPresetInfo,
  PipelineConfig,
  McpServerDefinition,
  McpProjectOverride,
  ProviderModel,
  ProviderModelsResult,
  CliToolStatus,
} from '@vibcode/shared';

import type {
  ChatSessionType,
  Project,
  QuickCreateResult,
  UpdateProjectPayload,
  Milestone,
  Issue,
  IssueComment,
  ChatSession,
  ChatMessage,
  UserSettings,
  SystemSetting,
  AgentRoleConfig,
  AgentPresetInfo,
  PipelineConfig,
  McpServerDefinition,
  McpProjectOverride,
  ProviderModelsResult,
  CliToolStatus,
  HardwareSnapshot,
  ActivityItem,
  AgentsOverview,
  PipelineFailureSummary,
} from '@vibcode/shared';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl;

  // ─── Projects ──────────────────────────────────────────────

  getProjects() {
    return this.http.get<Project[]>(`${this.baseUrl}/projects`);
  }

  getProject(slug: string) {
    return this.http.get<Project>(`${this.baseUrl}/projects/${slug}`);
  }

  createProject(data: Partial<Project>) {
    return this.http.post<Project>(`${this.baseUrl}/projects`, data);
  }

  quickCreateProject(name: string) {
    return this.http.post<QuickCreateResult>(
      `${this.baseUrl}/projects/quick`,
      { name },
    );
  }

  updateProject(id: string, data: UpdateProjectPayload) {
    return this.http.put<Project>(`${this.baseUrl}/projects/${id}`, data);
  }

  deleteProject(id: string) {
    return this.http.delete(`${this.baseUrl}/projects/${id}`);
  }

  // ─── Milestones ──────────────────────────────────────────

  getMilestones(projectId: string) {
    return this.http.get<Milestone[]>(`${this.baseUrl}/milestones`, {
      params: { projectId },
    });
  }

  // ─── Issues ────────────────────────────────────────────────

  getIssues(projectId: string) {
    return this.http.get<Issue[]>(`${this.baseUrl}/issues`, {
      params: { projectId },
    });
  }

  getIssue(id: string) {
    return this.http.get<Issue>(`${this.baseUrl}/issues/${id}`);
  }

  createIssue(data: {
    projectId: string;
    title: string;
    description?: string;
    priority?: string;
    labels?: string[];
    parentId?: string;
    syncToGitlab?: boolean;
  }) {
    return this.http.post<Issue>(`${this.baseUrl}/issues`, data);
  }

  updateIssue(id: string, data: Partial<Issue>) {
    return this.http.put<Issue>(`${this.baseUrl}/issues/${id}`, data);
  }

  deleteIssue(id: string) {
    return this.http.delete(`${this.baseUrl}/issues/${id}`);
  }

  getIssueComments(issueId: string) {
    return this.http.get<IssueComment[]>(`${this.baseUrl}/issues/${issueId}/comments`);
  }

  addIssueComment(issueId: string, data: { content: string; authorName?: string; syncToGitlab?: boolean }) {
    return this.http.post<IssueComment>(`${this.baseUrl}/issues/${issueId}/comments`, data);
  }

  // ─── Chat ──────────────────────────────────────────────────

  getChatSessions(projectId: string, type?: ChatSessionType) {
    const params: any = { projectId };
    if (type) params.type = type;
    return this.http.get<ChatSession[]>(`${this.baseUrl}/chat/sessions`, { params });
  }

  getChatSession(id: string) {
    return this.http.get<ChatSession>(`${this.baseUrl}/chat/sessions/${id}`);
  }

  createChatSession(data: { projectId: string; title?: string }) {
    return this.http.post<ChatSession>(`${this.baseUrl}/chat/sessions`, data);
  }

  deleteChatSession(id: string) {
    return this.http.delete(`${this.baseUrl}/chat/sessions/${id}`);
  }

  // ─── Dev Sessions (Branching) ───────────────────────────────

  createDevSession(data: { projectId: string; title?: string; branch?: string }) {
    return this.http.post<ChatSession>(`${this.baseUrl}/chat/sessions/dev`, data);
  }

  archiveSession(id: string) {
    return this.http.post<{ success: boolean; merged: boolean; conflicts?: string[]; error?: string }>(
      `${this.baseUrl}/chat/sessions/${id}/archive`, {},
    );
  }

  resolveSessionConflict(id: string) {
    return this.http.post<{ success: boolean; merged: boolean; error?: string }>(
      `${this.baseUrl}/chat/sessions/${id}/resolve`, {},
    );
  }

  continueSession(id: string) {
    return this.http.post<ChatSession>(
      `${this.baseUrl}/chat/sessions/${id}/continue`, {},
    );
  }

  updateSession(id: string, data: { title?: string }) {
    return this.http.patch<ChatSession>(`${this.baseUrl}/chat/sessions/${id}`, data);
  }

  getArchivedSessions(projectId: string) {
    return this.http.get<ChatSession[]>(`${this.baseUrl}/chat/sessions/archived`, {
      params: { projectId },
    });
  }

  getChatMessages(sessionId: string) {
    return this.http.get<ChatMessage[]>(
      `${this.baseUrl}/chat/sessions/${sessionId}/messages`,
    );
  }

  sendChatMessage(data: {
    chatSessionId: string;
    role: string;
    content: string;
  }) {
    return this.http.post<ChatMessage>(`${this.baseUrl}/chat/messages`, data);
  }

  uploadChatFile(chatSessionId: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('chatSessionId', chatSessionId);
    return this.http.post<ChatMessage>(`${this.baseUrl}/chat/upload`, formData);
  }

  // ─── Settings ────────────────────────────────────────────

  getUserSettings() {
    return this.http.get<UserSettings>(`${this.baseUrl}/settings/user`);
  }

  updateUserSettings(settings: { key: string; value: string }[]) {
    return this.http.put<UserSettings>(`${this.baseUrl}/settings/user`, {
      settings,
    });
  }

  getSystemSettings() {
    return this.http.get<SystemSetting[]>(`${this.baseUrl}/settings/system`);
  }

  updateSystemSettings(
    settings: {
      key: string;
      value: string;
      category?: string;
      encrypted?: boolean;
      description?: string;
    }[],
  ) {
    return this.http.put<SystemSetting[]>(`${this.baseUrl}/settings/system`, {
      settings,
    });
  }

  // ─── Agent Roles ──────────────────────────────────────────

  getAgentRoleConfigs() {
    return this.http.get<Record<string, AgentRoleConfig>>(
      `${this.baseUrl}/settings/agents/roles`,
    );
  }

  getPipelineConfig() {
    return this.http.get<PipelineConfig>(
      `${this.baseUrl}/settings/agents/pipeline`,
    );
  }

  getAgentPresets() {
    return this.http.get<AgentPresetInfo[]>(
      `${this.baseUrl}/settings/agents/presets`,
    );
  }

  applyAgentPreset(presetId: string) {
    return this.http.post<{ presetId: string; name: string; rolesUpdated: number }>(
      `${this.baseUrl}/settings/agents/presets/${presetId}`,
      {},
    );
  }

  // ─── MCP Servers ────────────────────────────────────────────

  getMcpServers() {
    return this.http.get<McpServerDefinition[]>(`${this.baseUrl}/mcp-servers`);
  }

  createMcpServer(dto: Partial<McpServerDefinition>) {
    return this.http.post<McpServerDefinition>(`${this.baseUrl}/mcp-servers`, dto);
  }

  updateMcpServer(id: string, dto: Partial<McpServerDefinition>) {
    return this.http.put<McpServerDefinition>(`${this.baseUrl}/mcp-servers/${id}`, dto);
  }

  deleteMcpServer(id: string) {
    return this.http.delete(`${this.baseUrl}/mcp-servers/${id}`);
  }

  setMcpServerRoles(id: string, roles: string[]) {
    return this.http.put<McpServerDefinition>(`${this.baseUrl}/mcp-servers/${id}/roles`, { roles });
  }

  // ─── MCP Project Overrides ────────────────────────────────

  getMcpProjectOverrides(projectId: string) {
    return this.http.get<McpProjectOverride[]>(
      `${this.baseUrl}/projects/${projectId}/mcp-overrides`,
    );
  }

  setMcpProjectOverride(projectId: string, data: { mcpServerId: string; agentRole: string; action: 'ENABLE' | 'DISABLE' }) {
    return this.http.put<McpProjectOverride>(
      `${this.baseUrl}/projects/${projectId}/mcp-overrides`,
      data,
    );
  }

  deleteMcpProjectOverride(projectId: string, data: { mcpServerId: string; agentRole: string }) {
    return this.http.delete(`${this.baseUrl}/projects/${projectId}/mcp-overrides`, { body: data });
  }

  // ─── Provider Discovery ───────────────────────────────────

  getProviderModels() {
    return this.http.get<Record<string, ProviderModelsResult>>(
      `${this.baseUrl}/settings/providers/models`,
    );
  }

  checkOllamaHealth() {
    return this.http.get<{ healthy: boolean; url: string }>(
      `${this.baseUrl}/settings/providers/ollama/health`,
    );
  }

  getCliToolStatus() {
    return this.http.get<CliToolStatus[]>(
      `${this.baseUrl}/settings/providers/cli/status`,
    );
  }

  // ─── Voice ───────────────────────────────────────────────

  getVoiceHealth() {
    return this.http.get<{ stt: boolean; tts: boolean; ttsEngine?: string; ttsVoices?: number }>(
      `${this.baseUrl}/voice/health`,
    );
  }

  getVoiceConfig() {
    return this.http.get<{
      enabled: boolean;
      sttUrl: string;
      ttsUrl: string;
      sttModel: string;
      sttLanguage: string;
      ttsEngine: string;
      ttsVoice: string;
      ttsSpeed: number;
    }>(`${this.baseUrl}/voice/config`);
  }

  getVoiceVoices() {
    return this.http.get<{ engine: string; voices: { id: string; name: string; locale?: string; quality?: string }[] }>(
      `${this.baseUrl}/voice/voices`,
    );
  }

  // ─── Monitor ──────────────────────────────────────────────

  getLatestPipelineFailure(projectId: string, chatSessionId: string) {
    return this.http.get<PipelineFailureSummary | null>(`${this.baseUrl}/agents/pipeline/latest-failure`, {
      params: { projectId, chatSessionId },
    });
  }

  resumePipeline(data: { projectId: string; chatSessionId: string; failedTaskId?: string }) {
    return this.http.post<{ resumed: boolean; resumedFromTaskId: string; resumedFromTaskType: string }>(
      `${this.baseUrl}/agents/pipeline/resume`,
      data,
    );
  }

  getHardwareStats() {
    return this.http.get<HardwareSnapshot>(`${this.baseUrl}/monitor/hardware`);
  }

  getHardwareHistory() {
    return this.http.get<HardwareSnapshot[]>(`${this.baseUrl}/monitor/hardware/history`);
  }

  getMonitorLogs(params?: { projectId?: string; agentRole?: string; level?: string; limit?: number; offset?: number }) {
    return this.http.get<{ logs: any[]; total: number }>(`${this.baseUrl}/monitor/logs`, { params: params as any });
  }

  getActivityFeed(params?: { projectId?: string; limit?: number; offset?: number }) {
    return this.http.get<{ items: ActivityItem[]; total: number }>(`${this.baseUrl}/monitor/activity`, { params: params as any });
  }

  getAgentsOverview() {
    return this.http.get<AgentsOverview>(`${this.baseUrl}/monitor/agents/overview`);
  }
}

// Re-export monitor types from shared
export type {
  GpuStats,
  CpuStats,
  RamStats,
  HardwareSnapshot,
  ActivityItem,
  AgentsOverview,
  AgentRoleOverview,
} from '@vibcode/shared';

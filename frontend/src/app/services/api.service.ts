import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  gitlabProjectId?: number;
  gitlabUrl?: string;
  createdAt: string;
  updatedAt: string;
  issues?: Issue[];
  agents?: AgentInstance[];
}

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  labels: string[];
  parentId?: string;
  subIssues?: Issue[];
  gitlabIid?: number;
  assignedAgent?: { id: string; role: string; status: string };
  createdAt: string;
  updatedAt: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  chatSessionId: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'AGENT';
  content: string;
  issueId?: string;
  agentTaskId?: string;
  createdAt: string;
}

export interface AgentInstance {
  id: string;
  role: string;
  provider: string;
  model: string;
  status: string;
}

export interface SystemSetting {
  key: string;
  value: string;
  category: string;
  encrypted: boolean;
  description: string | null;
}

export type UserSettings = Record<string, unknown>;

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

  deleteProject(id: string) {
    return this.http.delete(`${this.baseUrl}/projects/${id}`);
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

  // ─── Chat ──────────────────────────────────────────────────

  getChatSessions(projectId: string) {
    return this.http.get<ChatSession[]>(`${this.baseUrl}/chat/sessions`, {
      params: { projectId },
    });
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
}

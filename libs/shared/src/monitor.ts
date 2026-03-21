import type { AgentRole } from './enums';

// ─── Hardware ─────────────────────────────────────────────────

export interface GpuStats {
  index: number;
  name: string;
  temp: number;
  fanSpeed: number;
  powerDraw: number;
  gpuUtil: number;
  memUtil: number;
  gpuClock: number;
  memClock: number;
}

export interface CpuStats {
  temp: number;
  load1: number;
  load5: number;
  load15: number;
  powerDraw: number;
}

export interface RamStats {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  usedPercent: number;
}

export interface HardwareSnapshot {
  gpus: GpuStats[];
  cpu: CpuStats;
  ram: RamStats;
  timestamp: number;
}

// ─── Activity ─────────────────────────────────────────────────

export interface ActivityItem {
  type: 'log' | 'comment' | 'message';
  id: string;
  level?: string;
  message: string;
  agentRole?: string;
  projectName?: string;
  projectSlug?: string;
  projectId?: string;
  taskType?: string;
  issueTitle?: string;
  createdAt: string;
}

// ─── Agent Overview ───────────────────────────────────────────

export interface AgentsOverview {
  roles: AgentRoleOverview[];
  taskStats: Record<string, number>;
}

export interface AgentRoleOverview {
  role: AgentRole;
  status: string;
  activeProjects: Array<{ id: string; name: string; slug: string }>;
  currentTask: any;
  totalTasks: number;
}

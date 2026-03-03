/** A single task within a compiled issue */
export interface CompiledTask {
  title: string;
  description: string;
}

/** A compiled issue with its sub-tasks */
export interface CompiledIssue {
  title: string;
  description: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  labels: string[];
  tasks: CompiledTask[];
}

/** A milestone grouping related issues */
export interface CompiledMilestone {
  title: string;
  description: string;
  issues: CompiledIssue[];
}

/** Full result from the Issue Compiler Agent */
export interface IssueCompilerResult {
  milestones: CompiledMilestone[];
  issues: CompiledIssue[];
  totalMilestones: number;
  totalIssues: number;
  totalTasks: number;
}

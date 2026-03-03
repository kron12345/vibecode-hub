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

/** Full result from the Issue Compiler Agent */
export interface IssueCompilerResult {
  issues: CompiledIssue[];
  totalIssues: number;
  totalTasks: number;
}

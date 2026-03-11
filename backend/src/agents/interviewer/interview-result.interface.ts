/** A single feature with priority and optional details */
export interface InterviewFeature {
  title: string;
  description?: string;
  priority: 'must-have' | 'should-have' | 'nice-to-have';
  acceptanceCriteria?: string[];
}

/** Structured output from the interviewer agent */
export interface InterviewResult {
  description: string;
  techStack: {
    framework?: string;
    language?: string;
    backend?: string;
    database?: string;
    additional?: string[];
  };
  /** Rich features with priority — also accepts plain strings for backward compat */
  features: (InterviewFeature | string)[];
  mcpServers?: {
    name: string;
    purpose: string;
  }[];
  setupInstructions?: {
    initCommand?: string;
    additionalCommands?: string[];
  };
  deployment?: {
    isWebProject: boolean;
    devServerPort?: number;
    devServerCommand?: string;
    buildCommand?: string;
  };
}

/** Result from a feature interview (dev session) — no tech stack/deployment */
export interface FeatureInterviewResult {
  /** Brief description of what this session is about */
  sessionGoal: string;
  /** Features to build in this session */
  features: InterviewFeature[];
}

/** Partial progress emitted during interview for live requirement card */
export interface InterviewProgress {
  framework?: string;
  language?: string;
  backend?: string;
  database?: string;
  features?: InterviewFeature[];
  setupReady?: boolean;
}

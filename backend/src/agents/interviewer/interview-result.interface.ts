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
  features: string[];
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

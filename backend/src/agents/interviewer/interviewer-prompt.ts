import { Logger } from '@nestjs/common';
import { InterviewResult, InterviewProgress } from './interview-result.interface';

const logger = new Logger('InterviewerPrompt');

/** Marker the LLM emits when the interview is complete */
export const COMPLETION_MARKER = ':::INTERVIEW_COMPLETE:::';
/** Marker the LLM emits when the feature interview is complete */
export const FEATURE_COMPLETION_MARKER = ':::FEATURE_INTERVIEW_COMPLETE:::';
/** Marker for clickable suggestion chips */
export const SUGGESTIONS_MARKER = ':::SUGGESTIONS:::';
/** Marker for partial interview progress */
export const PROGRESS_MARKER = ':::PROGRESS:::';

/** Completion instructions appended to ALL system prompts (custom or default) */
export const COMPLETION_INSTRUCTIONS = `

## MANDATORY Completion Format (ALWAYS follow this)
When the interview is done, end your FINAL message with EXACTLY this format.
The marker line and JSON block MUST appear — without them the system cannot proceed.

${COMPLETION_MARKER}
\`\`\`json
{
  "description": "Brief project description",
  "techStack": {
    "framework": "angular",
    "language": "typescript",
    "backend": "none",
    "database": "none",
    "additional": ["tailwindcss"]
  },
  "features": [
    { "title": "Feature 1", "priority": "must-have", "description": "What it does", "acceptanceCriteria": ["It works when..."] },
    { "title": "Feature 2", "priority": "should-have", "description": "What it does" }
  ],
  "mcpServers": [
    { "name": "angular-mcp-server", "purpose": "Angular documentation" }
  ],
  "setupInstructions": {
    "initCommand": "npx @angular/cli new my-project --style=scss --standalone",
    "additionalCommands": ["npm install tailwindcss"]
  },
  "deployment": {
    "isWebProject": true,
    "devServerPort": 4200,
    "devServerCommand": "npx ng serve --port {PORT}",
    "buildCommand": "npx ng build"
  }
}
\`\`\`

CRITICAL RULES for completion:
- The line ${COMPLETION_MARKER} must appear EXACTLY as shown (no markdown formatting around it)
- The JSON must be valid and parseable
- For devServerCommand, always use {PORT} as placeholder
- If no backend: set backend and database to "none"
- If not a web project: set deployment.isWebProject to false
- additionalCommands: one command per array entry (each will be run separately)
- initCommand: the FULL command including project name and all flags
- Do NOT ask "shall I finalize?" — just finalize when you have the info`;

/**
 * Extract suggestions and progress markers from LLM response.
 * Returns cleaned content (without markers) + parsed data.
 */
export function extractMetadata(rawContent: string): {
  content: string;
  suggestions: string[];
  progress: InterviewProgress | null;
} {
  let content = rawContent;
  let suggestions: string[] = [];
  let progress: InterviewProgress | null = null;

  // Extract suggestions: :::SUGGESTIONS:::["A", "B", "C"]
  const sugMatch = content.match(
    new RegExp(
      `${SUGGESTIONS_MARKER.replace(/:/g, '\\:')}\\s*(\\[.*?\\])`,
      's',
    ),
  );
  if (sugMatch) {
    try {
      const parsed = JSON.parse(sugMatch[1]);
      if (Array.isArray(parsed)) {
        suggestions = parsed.map(String).slice(0, 6);
      }
    } catch {
      logger.debug('Failed to parse suggestions JSON');
    }
    content = content.replace(sugMatch[0], '').trim();
  }

  // Extract progress: :::PROGRESS:::{...}
  const progMatch = content.match(
    new RegExp(`${PROGRESS_MARKER.replace(/:/g, '\\:')}\\s*(\\{.*?\\})`, 's'),
  );
  if (progMatch) {
    try {
      progress = JSON.parse(progMatch[1]);
    } catch {
      logger.debug('Failed to parse progress JSON');
    }
    content = content.replace(progMatch[0], '').trim();
  }

  return { content, suggestions, progress };
}

/**
 * Detect completion from JSON-only responses where the LLM skipped the
 * :::INTERVIEW_COMPLETE::: marker but sent a structured result.
 */
export function detectJsonCompletion(content: string): boolean {
  const jsonMatch =
    content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
    content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return false;

  try {
    const obj = JSON.parse(jsonMatch[1]);

    // Check explicit completion signals
    if (obj.completion_marker === true) return true;
    if (obj.ready_for_issue_compiler === true) return true;
    if (
      obj.interview_status === 'completed' ||
      obj.interview_status === 'complete'
    )
      return true;

    // Check for structural completeness
    const hasSetup = !!(
      obj.techStack ||
      obj.tech_stack ||
      obj.setupInstructions ||
      obj.setup_instructions
    );
    const hasFeatures = !!(
      obj.features ||
      obj.core_features ||
      obj.feature_list
    );
    const hasDescription = !!(
      obj.description ||
      obj.summary ||
      obj.feature_name
    );
    if (hasSetup && hasFeatures && hasDescription) return true;

    return false;
  } catch {
    return false;
  }
}

/** Detect JSON-only completion for feature interviews */
export function detectFeatureJsonCompletion(content: string): boolean {
  const jsonMatch =
    content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
    content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return false;

  try {
    const obj = JSON.parse(jsonMatch[1]);
    const hasFeatures = !!(obj.features || obj.feature_list);
    const hasGoal = !!(
      obj.sessionGoal ||
      obj.session_goal ||
      obj.goal ||
      obj.description
    );
    return hasFeatures && hasGoal;
  } catch {
    return false;
  }
}

/** Normalize priority string to one of the three valid values */
export function normalizePriority(
  raw: any,
): 'must-have' | 'should-have' | 'nice-to-have' {
  if (!raw) return 'should-have';
  const s = String(raw)
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (
    s.includes('must') ||
    s.includes('critical') ||
    s.includes('high') ||
    s.includes('required')
  )
    return 'must-have';
  if (s.includes('nice') || s.includes('low') || s.includes('optional'))
    return 'nice-to-have';
  return 'should-have';
}

/** Sensible deployment defaults per framework (fallback when LLM omits) */
export function getFrameworkDefaults(framework: string): {
  port?: number;
  devCommand?: string;
  buildCommand?: string;
} {
  if (framework.includes('angular'))
    return {
      port: 4200,
      devCommand: 'npx ng serve --port {PORT}',
      buildCommand: 'npx ng build',
    };
  if (framework.includes('react') || framework.includes('next'))
    return {
      port: 3000,
      devCommand: 'npm run dev -- --port {PORT}',
      buildCommand: 'npm run build',
    };
  if (framework.includes('vue') || framework.includes('nuxt'))
    return {
      port: 5173,
      devCommand: 'npm run dev -- --port {PORT}',
      buildCommand: 'npm run build',
    };
  if (framework.includes('nest'))
    return {
      port: 3000,
      devCommand: 'npm run start:dev',
      buildCommand: 'npm run build',
    };
  if (
    framework.includes('express') ||
    framework.includes('fastapi') ||
    framework.includes('flask')
  )
    return { port: 3000 };
  if (
    framework.includes('vaadin') ||
    framework.includes('spring') ||
    framework.includes('quarkus')
  )
    return {
      port: 8080,
      devCommand: 'mvn spring-boot:run',
      buildCommand: 'mvn clean package -Pproduction',
    };
  if (framework.includes('java'))
    return {
      port: 8080,
      devCommand: 'mvn compile exec:java',
      buildCommand: 'mvn clean package',
    };
  return {};
}

/**
 * Normalize LLM output to our InterviewResult schema.
 * LLMs (especially local ones like qwen3.5) often use different key names
 * (snake_case, synonyms, etc.) — this maps common variants to our schema.
 */
export function normalizeInterviewResult(
  raw: Record<string, any>,
): InterviewResult {
  // Helper: find a value by trying multiple key variants
  const pick = (...keys: string[]): any => {
    for (const k of keys) {
      if (raw[k] !== undefined) return raw[k];
    }
    return undefined;
  };

  // Normalize techStack
  let techStack = pick(
    'techStack',
    'tech_stack',
    'technical_stack',
    'technology_stack',
  );
  if (!techStack || typeof techStack !== 'object') {
    techStack = {
      framework: pick('framework') ?? techStack?.framework,
      language: pick('language') ?? techStack?.language,
      backend: pick('backend') ?? 'none',
      database: pick('database', 'db') ?? 'none',
      additional: pick('additional', 'additional_packages', 'packages') ?? [],
    };
  }

  // Normalize features
  let features = pick('features', 'core_features', 'feature_list') ?? [];
  if (Array.isArray(features)) {
    features = features.map((f: any) => {
      if (typeof f === 'string') {
        return { title: f, priority: 'should-have' as const };
      }
      if (typeof f === 'object' && f !== null) {
        return {
          title: String(f.title ?? f.name ?? f.description ?? 'Unnamed'),
          description: f.description ? String(f.description) : undefined,
          priority: normalizePriority(f.priority),
          acceptanceCriteria: Array.isArray(
            f.acceptanceCriteria ?? f.acceptance_criteria,
          )
            ? (f.acceptanceCriteria ?? f.acceptance_criteria).map(String)
            : undefined,
        };
      }
      return { title: String(f), priority: 'should-have' as const };
    });
  }

  // Normalize setupInstructions
  let setup = pick('setupInstructions', 'setup_instructions', 'setup');
  if (!setup || typeof setup !== 'object') {
    setup = {};
  }
  const setupInstructions = {
    initCommand:
      setup.initCommand ??
      setup.init_command ??
      pick('initCommand', 'init_command'),
    additionalCommands:
      setup.additionalCommands ?? setup.additional_commands ?? [],
  };

  // Normalize deployment — apply framework defaults if LLM omitted fields
  let deploy = pick('deployment', 'deploy');
  if (!deploy || typeof deploy !== 'object') {
    deploy = {};
  }
  const fw = (techStack?.framework ?? '').toLowerCase();
  const frameworkDefaults = getFrameworkDefaults(fw);
  const deployment = {
    isWebProject: deploy.isWebProject ?? deploy.is_web_project ?? true,
    devServerPort:
      deploy.devServerPort ??
      deploy.dev_server_port ??
      deploy.port ??
      frameworkDefaults.port,
    devServerCommand:
      deploy.devServerCommand ??
      deploy.dev_server_command ??
      frameworkDefaults.devCommand,
    buildCommand:
      deploy.buildCommand ??
      deploy.build_command ??
      frameworkDefaults.buildCommand,
  };

  const result: InterviewResult = {
    description:
      pick('description', 'summary', 'project_description', 'feature_name') ??
      '',
    techStack,
    features,
    mcpServers: pick('mcpServers', 'mcp_servers') ?? [],
    setupInstructions,
    deployment,
  };

  logger.debug(
    `Normalized interview result: description=${!!result.description}, techStack.framework=${result.techStack?.framework}, features=${result.features?.length}`,
  );

  return result;
}

/** Build the system prompt for feature interviews */
export function buildFeatureInterviewPrompt(
  envContext: string,
  knowledgeContext: string,
  techLine: string,
): string {
  return `You are the Feature Interviewer for VibCode Hub — a dev session planning assistant.

## Your Role
You help the user plan what features to build in this development session.
The project is ALREADY SET UP (tech stack, repo, environment all exist).
You do NOT need to ask about tech stack, framework, init commands, or deployment.

## What You Know
${techLine ? `- **Tech Stack:** ${techLine}` : '- Tech stack details are in the environment doc below'}
${envContext}
${knowledgeContext}

## What You Need to Collect
For each feature the user wants to build:
- **title**: Short name (e.g. "User Authentication", "Dashboard Charts")
- **priority**: must-have, should-have, or nice-to-have
- **description**: 1-3 sentences about what it does and WHY
- **acceptanceCriteria**: How do we know it works? (e.g. "User can log in with email/password")

## Rules
- Ask 1-2 focused questions at a time
- Be practical: suggest related features based on what you know about the project
- Respond in the same language the user uses
- Keep it short: 3-6 questions total should be enough
- When you have a clear feature list, finalize immediately — do NOT ask "shall I finalize?"
- Draw from the project knowledge base and environment doc to understand context
- Do NOT ask about tech stack, setup, or deployment — that's already done

## Suggestions
After EVERY response (except the final completion), add 2-4 clickable suggestions:
${SUGGESTIONS_MARKER}["Feature idea A", "Feature idea B", "That's all, let's go!"]

## Completion
When you have enough features, finalize with EXACTLY this format:

${FEATURE_COMPLETION_MARKER}
\`\`\`json
{
  "sessionGoal": "Brief description of this session's goal",
  "features": [
    {
      "title": "Feature Name",
      "priority": "must-have",
      "description": "What it does and why",
      "acceptanceCriteria": ["Criteria 1", "Criteria 2"]
    }
  ]
}
\`\`\`

CRITICAL: The marker ${FEATURE_COMPLETION_MARKER} must appear EXACTLY as shown.
The JSON must be valid. Do NOT ask for confirmation — just finalize when ready.`;
}

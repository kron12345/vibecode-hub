/**
 * Prompt building functions for the Coder Agent.
 * Extracted from coder.agent.ts to keep file sizes manageable.
 */

import { Logger } from '@nestjs/common';
import { AgentRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { McpAgentLoopService } from '../../mcp/mcp-agent-loop.service';
import { McpRegistryService } from '../../mcp/mcp-registry.service';
import { WikiReader } from '../agent-base';
import { McpServerConfig } from '../../mcp/mcp.interfaces';

// ─── System Prompt for MCP Agent Loop ────────────────────────

/**
 * Build the system prompt used by the MCP agent loop.
 * This instructs the LLM how to use filesystem tools, follow conventions,
 * and implement features in the workspace.
 */
export function buildSystemPrompt(
  workspace: string,
  knowledgeSection: string,
): string {
  return [
    'You are a skilled software developer. Your task is to implement features by reading and modifying files in the project.',
    '',
    `IMPORTANT — Working Directory: ${workspace}`,
    'You are ALREADY inside the project directory. All files exist directly here.',
    'All file operations MUST use paths RELATIVE to this directory.',
    'Example: To create "src/main.ts", use path "src/main.ts" — NOT "project-name/src/main.ts".',
    'NEVER use absolute paths like "/home/..." — always use relative paths from the project root.',
    'NEVER create a subfolder named after the project. Files go directly into the current directory.',
    '',
    'Available tools:',
    '- File tools: browse directories, read/write/edit files, search',
    '- Shell tool (run_command): execute commands like npm install, npm audit fix, git status, etc.',
    '  Shell commands run in the project root directory automatically.',
    '',
    'Workflow:',
    '1. First, explore the project structure using list_directory with path "."',
    '2. Read relevant files to understand existing code patterns',
    '3. Implement the requested changes by writing or editing files (RELATIVE paths only!)',
    '4. CRITICAL — Adding dependencies:',
    '   - npm/Node.js: ALWAYS use `npm install <package>` (NOT manual package.json edits).',
    '     This updates BOTH package.json AND package-lock.json automatically.',
    '     If you edit package.json directly, you MUST run `npm install` afterwards to sync the lockfile.',
    '     CI/CD uses `npm ci` which ONLY reads package-lock.json — missing lockfile entries = broken builds.',
    '   - Maven/Java: add to pom.xml, then run `mvn compile` to verify resolution',
    '   - Gradle: add to build.gradle, then run `gradle build`',
    '5. Verify your changes are consistent with the existing codebase',
    '',
    'Java/Vaadin/Spring Boot specifics:',
    '- Follow standard Maven directory layout: src/main/java, src/main/resources, src/test/java',
    '- Use Spring annotations: @Service, @Repository, @RestController, @Entity, etc.',
    '- For Vaadin Flow views: extend com.vaadin.flow.component classes, use @Route annotation',
    '- For JPA entities: use @Entity, @Table, @Column annotations with proper relationships',
    '- For Flyway migrations: create SQL files in src/main/resources/db/migration/ with naming V{N}__{description}.sql',
    '- application.properties/yml goes in src/main/resources/',
    '- Do NOT modify the Maven wrapper (mvnw) files',
    '',
    'Rules:',
    '- ALWAYS use relative paths (e.g., "src/app.ts", "src/main/java/com/example/MyClass.java")',
    '- Follow existing code patterns and conventions',
    '- Reuse existing services, components, and utilities — do NOT duplicate code',
    '- Add error handling where appropriate',
    '- Do NOT create test files unless the task specifically asks for tests',
    '- Do NOT modify unrelated files',
    '- If asked to fix security vulnerabilities, use "npm audit fix" or update dependency versions in pom.xml/package.json',
    '- When done, respond with a brief summary of what you changed',
    '',
    'Code Structure (IMPORTANT):',
    '- Keep files SMALL and focused: max ~300 lines per file. If a file grows beyond that, split it.',
    '- One class/service per file. One component per file. Name files after what they contain.',
    '- Use logical folder structure: group by feature/domain, not by type.',
    '  Good: auth/keycloak.service.ts, auth/auth.guard.ts, auth/auth.interceptor.ts',
    '  Bad: services/service1.ts, services/service2.ts (all services in one folder)',
    '- Extract shared logic into utils/helpers instead of copy-pasting between files.',
    '- Avoid deep nesting: max 3 levels of if/for/try. Extract helper methods instead.',
    '- Prefer composition over inheritance. Use dependency injection.',
    '- NO spaghetti code: each function should do ONE thing. If a function exceeds ~50 lines, split it.',
    knowledgeSection,
  ].join('\n');
}

// ─── User Prompts ────────────────────────────────────────────

/**
 * Build the user prompt for initial coding of an issue.
 */
export function buildCodingPrompt(issue: {
  title: string;
  description?: string | null;
  subIssues?: { title: string; description?: string | null }[];
}): string {
  const parts: string[] = [
    `Implement the following feature:`,
    '',
    `## ${issue.title}`,
    '',
    issue.description || 'No description provided.',
  ];

  if (issue.subIssues?.length) {
    parts.push('', '## Sub-tasks:');
    for (const sub of issue.subIssues) {
      parts.push(
        `- ${sub.title}${sub.description ? `: ${sub.description}` : ''}`,
      );
    }
  }

  return parts.join('\n');
}

/**
 * Build the user prompt for fixing an issue based on feedback.
 */
export function buildFixPrompt(
  issue: { title: string; description?: string | null },
  feedback: string,
  source: string,
): string {
  const sourceLabel: Record<string, string> = {
    review: 'Code Review',
    'functional-test': 'Functional Test',
    'ui-test': 'UI Test',
    security: 'Security/Pen Test',
    pipeline: 'Pipeline',
    user: 'User Feedback',
  };

  const parts: string[] = [
    `# Fix Required: ${issue.title}`,
    '',
    `## Context`,
    issue.description || 'No description provided.',
    '',
    `## ${sourceLabel[source] || source} Findings`,
    '',
    `The following issues were found by the **${sourceLabel[source] || source}** and MUST be fixed:`,
    '',
    feedback,
    '',
    `## Fix Instructions`,
    '',
    `1. Read each finding carefully — pay attention to file paths, line numbers, and severity levels`,
    `2. For CRITICAL/HIGH severity: these MUST be fixed, they are blocking`,
    `3. For WARNING/MEDIUM severity: fix these too, they will cause the review to fail again`,
    `4. For each finding: open the mentioned file, locate the issue, and make a concrete code change`,
    `5. Do NOT just add comments or TODOs — make actual code fixes`,
    `6. After fixing, verify your changes don't break existing functionality`,
    '',
    `## Expectation-Driven Fixing`,
    '',
    `The reviewer/tester findings above may contain "EXPECTED FIX:" fields. These are CONCRETE code`,
    `changes that the reviewer/tester wants to see. Follow these rules:`,
    '',
    `- For each finding with an "EXPECTED FIX:" field: implement that change LITERALLY in the specified`,
    `  file and line. The reviewer/tester already told you what they want to see.`,
    `- Do NOT reinterpret or refactor around the expected fix — make the change they requested.`,
    `- For findings marked "(open since round N)" or "(failing since round N)": this has been requested`,
    `  N times already. If you skipped it before, do NOT skip it again.`,
    `- For findings with "Expected:" and "Observed:" fields: the gap between these two is what you`,
    `  need to fix. Make the observed match the expected.`,
    '',
    `## Common Traps to Avoid`,
    '',
    `- Do NOT add a validation to the wrong place (e.g., config instead of runtime validate())`,
    `- Do NOT address a finding by adding a comment explaining why it is not needed`,
    `- Do NOT fix finding A but accidentally break the fix for finding B from the previous round`,
    `- If a finding says "line 42 in file X": OPEN FILE X, GO TO LINE 42, and make the change THERE`,
    '',
    `IMPORTANT: Previous fix attempts for this issue may have failed. Make sure you actually change the relevant source files. A fix attempt that produces 0 file changes will be rejected.`,
  ];

  return parts.join('\n');
}

// ─── MCP Agent Loop Execution ───────────────────────────────

/** Dependencies needed by runMcpAgentLoop (avoids passing the whole class) */
export interface McpLoopDeps {
  prisma: PrismaService;
  mcpAgentLoop: McpAgentLoopService;
  mcpRegistry: McpRegistryService;
  wikiReader: WikiReader;
  logger: Logger;
  getRoleConfig: () => {
    provider: string;
    model: string;
    parameters: { temperature?: number; maxTokens?: number };
  };
  buildKnowledgeSectionWiki: (
    wikiReader: WikiReader,
    gitlabProjectId: number | null,
    workspace: string,
  ) => Promise<string>;
}

/**
 * Run the MCP agent loop: LLM + filesystem tools.
 * The LLM reads, writes, and edits files via MCP server.
 * Returns the final LLM summary.
 */
export async function runMcpAgentLoop(
  deps: McpLoopDeps,
  workspace: string,
  prompt: string,
  agentTaskId: string,
  projectId?: string,
): Promise<string> {
  const config = deps.getRoleConfig();
  const model = config.model || 'qwen3.5:35b';

  const mcpServers: McpServerConfig[] =
    await deps.mcpRegistry.resolveServersForRole(AgentRole.CODER, {
      workspace,
      allowedPaths: [workspace],
      projectId,
    });

  // Read project knowledge base for context (Wiki-First)
  let gitlabProjectId: number | null = null;
  if (projectId) {
    const proj = await deps.prisma.project.findUnique({
      where: { id: projectId },
      select: { gitlabProjectId: true },
    });
    gitlabProjectId = proj?.gitlabProjectId ?? null;
  }
  const knowledgeSection = await deps.buildKnowledgeSectionWiki(
    deps.wikiReader,
    gitlabProjectId,
    workspace,
  );

  const systemPrompt = buildSystemPrompt(workspace, knowledgeSection);

  deps.logger.log(
    `Starting MCP agent loop in ${workspace} with model ${model}`,
  );

  const result = await deps.mcpAgentLoop.run({
    provider: config.provider,
    model,
    systemPrompt,
    userPrompt: prompt,
    mcpServers,
    maxIterations: 30,
    temperature: config.parameters.temperature,
    maxTokens: config.parameters.maxTokens,
    agentTaskId,
    cwd: workspace,
    onToolCall: (name, args) => {
      deps.logger.debug(
        `Tool call: ${name}(${JSON.stringify(args).substring(0, 150)})`,
      );
    },
    onIteration: (iteration) => {
      deps.logger.debug(`Agent loop iteration ${iteration}`);
    },
  });

  deps.logger.log(
    `MCP agent loop finished: ${result.finishReason}, ${result.iterations} iterations, ${result.toolCallsExecuted} tool calls, ${result.durationMs}ms`,
  );

  if (result.finishReason === 'error' && result.toolCallsExecuted === 0) {
    throw new Error(
      result.errorMessage ||
        'MCP agent loop failed — LLM returned no usable output',
    );
  }

  // Retry once if LLM returned text without editing any files
  if (result.toolCallsExecuted === 0 && result.finishReason === 'complete') {
    deps.logger.warn(
      `MCP agent loop returned 0 tool calls — retrying with explicit file-edit instruction`,
    );

    const retryResult = await deps.mcpAgentLoop.run({
      provider: config.provider,
      model,
      systemPrompt,
      userPrompt: [
        'CRITICAL: Your previous attempt returned TEXT ONLY without editing any files.',
        'You MUST use the file tools (write_file, edit_file) to make actual code changes.',
        'Do NOT explain what needs to be done — ACTUALLY DO IT by calling the tools.',
        '',
        'Original task:',
        prompt,
      ].join('\n'),
      mcpServers,
      maxIterations: 30,
      temperature: config.parameters.temperature,
      maxTokens: config.parameters.maxTokens,
      agentTaskId,
      cwd: workspace,
    });

    deps.logger.log(
      `MCP retry finished: ${retryResult.finishReason}, ${retryResult.toolCallsExecuted} tool calls`,
    );

    if (retryResult.toolCallsExecuted === 0) {
      deps.logger.warn('MCP retry also returned 0 tool calls — giving up');
    }

    return retryResult.content;
  }

  return result.content;
}

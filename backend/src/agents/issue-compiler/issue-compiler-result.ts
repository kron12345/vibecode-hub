import { Logger } from '@nestjs/common';
import {
  CompiledIssue,
  CompiledMilestone,
  CompiledTask,
  IssueCompilerResult,
} from './issue-compiler-result.interface';

const logger = new Logger('IssueCompilerResult');

/** Marker the LLM emits when compilation is done */
export const COMPLETION_MARKER = ':::ISSUES_COMPILED:::';

/** Completion instructions appended to ALL system prompts (custom or default) */
export const ISSUE_COMPLETION_INSTRUCTIONS = `

## MANDATORY Quality Standards (ALWAYS follow these)

### Issue Descriptions — MINIMUM REQUIREMENTS
Every issue description MUST use this Markdown structure:
- **Overview** (2-3 sentences): What and why
- **Requirements** (bullet list): Specific, testable requirements including edge cases
- **Technical Notes** (bullet list): Suggested approach, components, files, endpoints, data models
- **Acceptance Criteria** (checkbox list): Verifiable conditions for "done"

Minimum 400 characters per issue description. The Coder Agent implements ONLY what you describe — omissions become bugs.

### Task Descriptions — MINIMUM REQUIREMENTS
Every task description MUST be 2-4 sentences (minimum 100 characters) explaining exactly what to implement, which files to touch, and what the expected behavior is.

## MANDATORY Completion Format (ALWAYS follow this)
When done compiling issues, end your message with EXACTLY this format.
The marker line and JSON block MUST appear — without them the system cannot proceed.

${COMPLETION_MARKER}
\`\`\`json
{
  "milestones": [
    {
      "title": "v0.1 — Phase Name",
      "description": "What this phase achieves and what should be working by the end (2-3 sentences).",
      "issues": [
        {
          "title": "Specific imperative issue title",
          "description": "## Overview\\nWhat needs to be built and why (2-3 sentences).\\n\\n## Requirements\\n- Specific testable requirement 1\\n- Specific testable requirement 2\\n- Edge case handling\\n\\n## Technical Notes\\n- Suggested component/service/endpoint names\\n- Data model details\\n- Integration points with other features\\n\\n## Acceptance Criteria\\n- [ ] Verifiable condition 1\\n- [ ] Verifiable condition 2\\n- [ ] Error/edge case handled",
          "priority": "HIGH",
          "labels": ["frontend", "setup"],
          "tasks": [
            {
              "title": "Specific task title with context",
              "description": "2-4 sentences explaining what to implement. Name the files, components, or services to create. Describe the expected inputs, outputs, and behavior including error handling."
            }
          ]
        }
      ]
    }
  ]
}
\`\`\`

CRITICAL RULES:
- The JSON must be valid and parseable
- Every issue description MUST be at least 400 characters with all 4 sections (Overview, Requirements, Technical Notes, Acceptance Criteria)
- Every task description MUST be at least 100 characters (2+ sentences)
- Group ALL issues into milestones — do not return a flat "issues" array at the top level
- Use \\n for newlines inside JSON strings
- Do NOT include thinking tags, comments, or trailing commas in the JSON`;

/**
 * Extract a balanced JSON object from a string by counting brackets.
 * Handles cases where LLM adds text after the JSON.
 */
export function extractBalancedJson(str: string): string | null {
  const start = str.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(start, i + 1);
      }
    }
  }

  return null;
}

/** Normalize a raw issues array from LLM output */
export function normalizeIssues(rawIssues: any[]): CompiledIssue[] {
  return rawIssues.map((raw: any) => {
    const title = raw.title ?? raw.name ?? raw.summary ?? 'Untitled Issue';
    const description = raw.description ?? raw.body ?? raw.details ?? '';

    // Normalize priority
    let priority = (raw.priority ?? raw.severity ?? 'MEDIUM').toUpperCase();
    if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority)) {
      priority = 'MEDIUM';
    }

    // Normalize labels
    let labels = raw.labels ?? raw.tags ?? [];
    if (typeof labels === 'string') {
      labels = labels.split(',').map((l: string) => l.trim().toLowerCase());
    }
    labels = labels.map((l: string) => l.toLowerCase());

    // Normalize tasks
    const tasks: CompiledTask[] = (
      raw.tasks ??
      raw.subtasks ??
      raw.sub_tasks ??
      raw.children ??
      []
    ).map((t: any) => ({
      title: t.title ?? t.name ?? t.summary ?? 'Untitled Task',
      description: t.description ?? t.body ?? t.details ?? '',
    }));

    // Ensure at least 2 tasks
    if (tasks.length < 2) {
      tasks.push({
        title: `Implement ${title}`,
        description: 'Core implementation',
      });
      if (tasks.length < 2) {
        tasks.push({
          title: `Test ${title}`,
          description: 'Write tests and verify',
        });
      }
    }

    return {
      title,
      description,
      priority: priority as CompiledIssue['priority'],
      labels,
      tasks,
    };
  });
}

/**
 * Normalize raw LLM output into a structured IssueCompilerResult.
 * Handles milestone-grouped or flat issues lists.
 */
export function normalizeResult(
  raw: Record<string, any>,
): IssueCompilerResult {
  // Helper: find a value by trying multiple key variants
  const pick = (...keys: string[]): any => {
    for (const k of keys) {
      if (raw[k] !== undefined) return raw[k];
    }
    return undefined;
  };

  // Try to extract milestones
  const rawMilestones: any[] | undefined = pick(
    'milestones',
    'phases',
    'versions',
    'sprints',
  );

  let milestones: CompiledMilestone[];

  if (Array.isArray(rawMilestones) && rawMilestones.length > 0) {
    milestones = rawMilestones.map((m: any, i: number) => ({
      title: m.title ?? m.name ?? `v0.${i + 1} — Phase ${i + 1}`,
      description: m.description ?? m.summary ?? '',
      issues: normalizeIssues(m.issues ?? m.items ?? m.tickets ?? []),
    }));
  } else {
    // Fallback: flat issues list -> wrap in single milestone
    const flatIssues =
      pick('issues', 'items', 'tickets', 'compiled_issues') ?? [];
    milestones = [
      {
        title: 'v0.1 — MVP',
        description: 'All project issues',
        issues: normalizeIssues(flatIssues),
      },
    ];
  }

  // Build flat issues array from milestones
  const allIssues = milestones.flatMap((m) => m.issues);
  const totalTasks = allIssues.reduce((sum, i) => sum + i.tasks.length, 0);

  logger.debug(
    `Normalized: ${milestones.length} milestones, ${allIssues.length} issues, ${totalTasks} tasks`,
  );

  return {
    milestones,
    issues: allIssues,
    totalMilestones: milestones.length,
    totalIssues: allIssues.length,
    totalTasks,
  };
}

/**
 * Parse raw LLM response content into a JSON object for the issue compiler.
 * Handles completion markers, think tags, code fences, and bracket balancing.
 */
export function parseCompilationJson(content: string): Record<string, any> {
  let jsonPart = content.includes(COMPLETION_MARKER)
    ? content.substring(
        content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
      )
    : content;

  // Strip thinking tags that local LLMs (qwen3.5) often wrap around output
  jsonPart = jsonPart.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Strip Markdown code fences
  const codeFenceMatch = jsonPart.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeFenceMatch) {
    jsonPart = codeFenceMatch[1].trim();
  }

  // Try to find the outermost JSON object
  const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in LLM response');
  }

  // Clean common JSON issues from local LLMs
  let jsonStr = jsonMatch[0];
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  // Try parsing as-is first
  try {
    return JSON.parse(jsonStr);
  } catch (firstErr) {
    // Attempt bracket-balanced extraction from the beginning
    logger.warn(
      `First JSON parse failed (${firstErr.message}), trying bracket-balanced extraction`,
    );
    const balanced = extractBalancedJson(jsonStr);
    if (balanced) {
      const cleaned = balanced.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(cleaned);
    }
    throw firstErr;
  }
}

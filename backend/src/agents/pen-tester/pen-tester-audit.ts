/**
 * Security audit execution utilities for the Pen Tester agent.
 *
 * Extracted from pen-tester.agent.ts — contains npm audit, HTTP header
 * checks, tech-stack context builder, and diff fetching with retry.
 */

import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PenTestResult } from './pen-test-result.interface';
import { GitlabService } from '../../gitlab/gitlab.service';

const execFileAsync = promisify(execFile);

const HTTP_TIMEOUT_MS = 10_000;

const SECURITY_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'x-xss-protection',
  'referrer-policy',
  'permissions-policy',
];

// ─── npm audit (production deps only) ────────────────────

export async function runNpmAudit(
  workspace: string,
  auditTimeoutMs: number,
  logger: Logger,
): Promise<{
  report: string;
  summary: PenTestResult['auditResult'];
}> {
  try {
    // --omit=dev: Only audit production dependencies to reduce false positives
    const { stdout } = await execFileAsync(
      'npm',
      ['audit', '--omit=dev', '--json'],
      {
        cwd: workspace,
        timeout: auditTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
    ).catch((err) => {
      // npm audit exits with code 1 when vulnerabilities found — still has useful stdout
      if (err.stdout) return { stdout: err.stdout, stderr: err.stderr };
      throw err;
    });

    const auditData = JSON.parse(stdout);
    const meta = auditData.metadata?.vulnerabilities || {};

    const summary = {
      vulnerabilities: (meta.total ?? 0) as number,
      critical: (meta.critical ?? 0) as number,
      high: (meta.high ?? 0) as number,
    };

    // Format report for LLM
    const lines = [
      `**Scope:** Production dependencies only (dev excluded)`,
      `Total vulnerabilities: ${summary.vulnerabilities}`,
      `Critical: ${summary.critical}`,
      `High: ${summary.high}`,
    ];

    // List top advisories
    const advisories =
      auditData.advisories || auditData.vulnerabilities || {};
    const entries = Object.values(advisories).slice(0, 10);
    for (const adv of entries as any[]) {
      const name = adv.name || adv.module_name || 'unknown';
      const severity = adv.severity || 'unknown';
      const title = adv.title || adv.overview || '';
      lines.push(`- **${severity}** \`${name}\`: ${title.substring(0, 100)}`);
    }

    return { report: lines.join('\n'), summary };
  } catch (err) {
    logger.warn(`npm audit failed: ${err.message}`);
    return {
      report: `_npm audit failed: ${err.message}_`,
      summary: undefined,
    };
  }
}

// ─── HTTP Header Check ──────────────────────────────────

export async function checkSecurityHeaders(
  url: string,
  logger: Logger,
): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const lines: string[] = [
      `**URL:** ${url}`,
      `**Status:** ${response.status}`,
      '',
      '### Security Headers:',
    ];

    for (const header of SECURITY_HEADERS) {
      const value = response.headers.get(header);
      if (value) {
        lines.push(`- ✅ \`${header}\`: ${value.substring(0, 100)}`);
      } else {
        lines.push(`- ❌ \`${header}\`: **MISSING**`);
      }
    }

    lines.push(
      '',
      '_Note: Missing headers on dev/preview servers are typically info-level, not warnings._',
    );

    return lines.join('\n');
  } catch (err) {
    logger.warn(`Header check failed: ${err.message}`);
    return `_Security header check failed: ${err.message}_`;
  }
}

// ─── Tech Stack Context Builder ────────────────────────────

export function buildTechStackContext(project: any): string {
  if (!project?.techStack) {
    return '_No tech stack information available._';
  }

  const ts = project.techStack as Record<string, unknown>;
  const parts: string[] = [];

  const stack = ts['techStack'] as Record<string, unknown> | undefined;
  if (stack) {
    if (stack['framework'])
      parts.push(`- **Framework:** ${stack['framework']}`);
    if (stack['language']) parts.push(`- **Language:** ${stack['language']}`);
    if (stack['backend']) parts.push(`- **Backend:** ${stack['backend']}`);
    if (stack['database']) parts.push(`- **Database:** ${stack['database']}`);
  }

  const deploy = ts['deployment'] as Record<string, unknown> | undefined;
  if (deploy) {
    parts.push(`- **Web Project:** ${deploy['isWebProject'] ? 'Yes' : 'No'}`);
    if (deploy['devServerCommand'])
      parts.push(`- **Dev Server:** ${deploy['devServerCommand']}`);
  }

  if (parts.length === 0) return '_Minimal tech stack info._';

  // Determine project type for LLM context
  const framework = String(stack?.['framework'] ?? '').toLowerCase();
  const backend = String(stack?.['backend'] ?? '').toLowerCase();

  let projectType = 'Full-Stack Application';
  if (
    !backend &&
    (framework.includes('angular') ||
      framework.includes('react') ||
      framework.includes('vue'))
  ) {
    projectType = 'Frontend-Only SPA (no backend)';
  } else if (
    !framework &&
    (backend.includes('nest') ||
      backend.includes('express') ||
      backend.includes('fastify'))
  ) {
    projectType = 'Backend API (no frontend)';
  } else if (framework === 'static' || framework === 'html') {
    projectType = 'Static Site';
  }

  parts.unshift(`- **Project Type:** ${projectType}`);
  return parts.join('\n');
}

// ─── Diff Fetching ──────────────────────────────────────

export async function fetchDiffsWithRetry(
  gitlabService: GitlabService,
  gitlabProjectId: number,
  mrIid: number,
  maxRetries: number,
  delayMs: number,
  logger: Logger,
): Promise<any[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const diffs = await gitlabService.getMergeRequestDiffs(
        gitlabProjectId,
        mrIid,
      );
      if (diffs.length > 0) return diffs;
    } catch (err) {
      logger.warn(
        `Diff fetch attempt ${attempt}/${maxRetries} failed for MR !${mrIid}: ${err.message}`,
      );
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  logger.warn(
    `MR !${mrIid} still has no diffs after ${maxRetries} attempts`,
  );
  return [];
}

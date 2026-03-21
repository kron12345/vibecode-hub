/**
 * Git helper functions for the Coder Agent.
 * Extracted from coder.agent.ts to keep file sizes manageable.
 *
 * All functions are standalone — they receive the workspace path, a logger,
 * and a timeout getter so they stay free of DI dependencies.
 */

import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Slug from issue title for branch names */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
}

export async function gitPull(
  cwd: string,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  try {
    await execFileAsync('git', ['pull', '--ff-only'], {
      cwd,
      timeout: timeoutMs,
    });
  } catch (err) {
    logger.debug(`git pull failed (non-fatal): ${err.message}`);
  }
}

export async function gitCheckout(
  cwd: string,
  branch: string,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  // Stash any uncommitted AND untracked changes before switching branches
  try {
    const { stdout: status } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      { cwd, timeout: timeoutMs },
    );
    if (status.trim()) {
      logger.debug(
        `Stashing ${status.trim().split('\n').length} changes (incl. untracked) before checkout ${branch}`,
      );
      await execFileAsync(
        'git',
        [
          'stash',
          'push',
          '--include-untracked',
          '-m',
          `auto-stash before checkout ${branch}`,
        ],
        { cwd, timeout: timeoutMs },
      );
    }
  } catch (stashErr) {
    logger.warn(`git stash failed: ${stashErr.message}`);
  }
  try {
    await execFileAsync('git', ['checkout', branch], {
      cwd,
      timeout: timeoutMs,
    });
  } catch (checkoutErr) {
    // Handle "branch already checked out in another worktree" error
    // CLI tools (Codex, Claude) can leave stale /tmp worktrees referencing the branch
    if (
      checkoutErr.message?.includes('Arbeitsverzeichnis') ||
      checkoutErr.message?.includes('worktree')
    ) {
      logger.warn(
        `Branch ${branch} locked by another worktree — pruning stale worktrees and retrying`,
      );
      try {
        await execFileAsync('git', ['worktree', 'prune'], {
          cwd,
          timeout: timeoutMs,
        });
        await execFileAsync('git', ['checkout', branch], {
          cwd,
          timeout: timeoutMs,
        });
        return;
      } catch {
        logger.warn(
          `Worktree prune didn't help — force-removing stale worktree locks`,
        );
        // Find and remove the stale worktree
        try {
          const { stdout: worktreeList } = await execFileAsync(
            'git',
            ['worktree', 'list', '--porcelain'],
            { cwd, timeout: timeoutMs },
          );
          const lines = worktreeList.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('branch refs/heads/' + branch)) {
              // Previous line has the worktree path
              const pathLine = lines[i - 2] || '';
              const wtPath = pathLine.replace('worktree ', '').trim();
              if (wtPath && wtPath.startsWith('/tmp/')) {
                logger.log(
                  `Removing stale worktree at ${wtPath} for branch ${branch}`,
                );
                await execFileAsync(
                  'git',
                  ['worktree', 'remove', '--force', wtPath],
                  { cwd, timeout: timeoutMs },
                ).catch((err) => {
                  logger.warn(
                    `Failed to remove stale worktree ${wtPath}: ${err.message}`,
                  );
                });
                await execFileAsync('git', ['checkout', branch], {
                  cwd,
                  timeout: timeoutMs,
                });
                return;
              }
            }
          }
        } catch {
          /* fall through to original error */
        }
      }
      throw checkoutErr;
    }
    throw checkoutErr;
  }
}

export async function gitCreateBranch(
  cwd: string,
  branch: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await execFileAsync('git', ['checkout', '-b', branch], {
      cwd,
      timeout: timeoutMs,
    });
  } catch {
    // Branch may already exist — try to check it out
    await execFileAsync('git', ['checkout', branch], {
      cwd,
      timeout: timeoutMs,
    });
  }
}

/**
 * Get changed files — checks both uncommitted changes (git status) AND
 * committed changes vs default branch (git diff). CLI providers like Codex
 * commit changes directly, so git status alone returns empty.
 */
export async function getChangedFiles(
  cwd: string,
  defaultBranch: string,
  timeoutMs: number,
  logger: Logger,
): Promise<string[]> {
  const files = new Set<string>();

  // 1. Uncommitted changes (for MCP/API providers that don't commit)
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    for (const line of stdout.trim().split('\n')) {
      if (line.trim()) files.add(line.substring(3).trim());
    }
  } catch {
    /* ignore */
  }

  // 2. Committed changes vs default branch (for CLI providers that auto-commit)
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', defaultBranch + '...HEAD'],
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    for (const line of stdout.trim().split('\n')) {
      if (line.trim()) files.add(line.trim());
    }
  } catch (err) {
    logger.debug(`git diff vs ${defaultBranch} failed: ${err.message}`);
  }

  return [...files];
}

/**
 * Commit uncommitted changes (if any) and push the branch.
 * CLI providers may already have committed — in that case we skip the commit
 * and just push their commits.
 */
export async function gitCommitAndPush(
  cwd: string,
  branch: string,
  message: string,
  timeoutMs: number,
  logger: Logger,
): Promise<string> {
  // Stage and commit any uncommitted changes (may be empty for CLI providers)
  await execFileAsync('git', ['add', '.'], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  try {
    await execFileAsync('git', ['commit', '-m', message], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (commitErr) {
    // "nothing to commit" is fine — CLI provider already committed
    // Check message, stdout, AND stderr since Node distributes the text across properties
    const errText = [commitErr.message, commitErr.stdout, commitErr.stderr]
      .filter(Boolean)
      .join(' ');
    if (
      !errText.includes('nothing to commit') &&
      !errText.includes('nichts zu committen')
    ) {
      throw commitErr;
    }
    logger.debug(
      'No uncommitted changes to commit — CLI provider likely already committed',
    );
  }

  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd,
    timeout: timeoutMs,
  });
  const commitSha = stdout.trim();

  await execFileAsync('git', ['push', '-u', 'origin', branch], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return commitSha;
}

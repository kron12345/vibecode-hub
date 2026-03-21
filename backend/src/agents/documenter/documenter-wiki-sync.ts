import { Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs/promises';
import { GitlabService } from '../../gitlab/gitlab.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocFile } from './documenter-result.interface';
import { ScreenshotManifest } from '../ui-tester/ui-test-result.interface';

// ─── Types ────────────────────────────────────────────────

export interface WikiSyncContext {
  gitlabProjectId: number;
  projectName: string;
  issueIid: number;
  issueId: string;
  issueTitle: string;
  issueDescription: string;
  featureSlug: string;
  workspace: string;
}

export interface WikiSyncResult {
  wikiPages: string[];
  screenshotWikiContent: string;
  screenshotWikiImages: string[];
}

// ─── Main Wiki Sync Orchestrator ──────────────────────────

/**
 * Sync documentation files to GitLab Wiki, create feature subpages,
 * handle screenshots, update home page, and regenerate sidebar.
 */
export async function syncDocsToWiki(
  ctx: WikiSyncContext,
  docFiles: DocFile[],
  diffs: any[],
  writtenFiles: string[],
  docSummary: string,
  gitlabService: GitlabService,
  logger: Logger,
): Promise<WikiSyncResult> {
  const {
    gitlabProjectId,
    projectName,
    issueIid,
    issueId,
    issueTitle,
    featureSlug,
    workspace,
  } = ctx;

  // ─── Screenshot Processing ──────────────────────────────
  let screenshotWikiContent = '';
  const screenshotWikiImages: string[] = [];
  try {
    const screenshotResult = await processScreenshots(
      workspace,
      issueId,
      gitlabProjectId,
      issueTitle,
      gitlabService,
      logger,
    );
    if (screenshotResult) {
      screenshotWikiContent = screenshotResult.wikiContent;
      screenshotWikiImages.push(...screenshotResult.uploadedFiles);
      logger.log(
        `Screenshots processed: ${screenshotResult.uploadedFiles.length} uploaded`,
      );
    }
  } catch (err) {
    logger.warn(`Screenshot processing failed: ${err.message}`);
  }

  // ─── Wiki Sync — Hierarchical Pages ──────────────────────
  // Sync all markdown files to wiki + create feature subpage + update home/sidebar
  // Guard: never overwrite a longer wiki page with a shorter LLM summary
  const wikiFiles = docFiles.filter((f) => f.path.endsWith('.md'));
  const wikiPages: string[] = [];
  for (const wf of wikiFiles) {
    try {
      const title = wf.path.replace(/\.md$/i, '').replace(/\//g, '-');

      // Read existing wiki content to prevent overwrite-with-shorter
      const existingWikiContent = await gitlabService
        .getWikiPageContent(gitlabProjectId, title)
        .catch(() => '');

      // Only update if new content is substantially longer or page doesn't exist yet
      if (
        existingWikiContent &&
        wf.content.length < existingWikiContent.length * 0.7
      ) {
        logger.warn(
          `Wiki page "${title}" not updated: new content (${wf.content.length} chars) shorter than existing (${existingWikiContent.length} chars) — would lose data`,
        );
        wikiPages.push(title);
        continue;
      }

      await gitlabService.upsertWikiPage(gitlabProjectId, title, wf.content);
      wikiPages.push(title);
      logger.log(`Wiki page synced: ${title}`);
    } catch (err) {
      logger.warn(`Wiki sync failed for ${wf.path}: ${err.message}`);
    }
  }

  // Create a feature subpage for this issue
  if (issueIid > 0) {
    try {
      const featureTitle = `Features/Issue-${issueIid}-${featureSlug}`;
      const featureContent = buildFeaturePageContent(
        issueTitle,
        issueIid,
        ctx.issueDescription,
        docSummary,
        writtenFiles,
        diffs,
        screenshotWikiContent,
      );
      await gitlabService.upsertWikiPage(
        gitlabProjectId,
        featureTitle,
        featureContent,
      );
      wikiPages.push(featureTitle);
      logger.log(`Feature wiki page created: ${featureTitle}`);
    } catch (err) {
      logger.warn(`Feature wiki page failed: ${err.message}`);
    }
  }

  // Screenshot wiki page (under UI-Screenshots/ hierarchy)
  if (screenshotWikiContent) {
    try {
      const screenshotTitle = `UI-Screenshots/Issue-${issueIid || issueId}`;
      await gitlabService.upsertWikiPage(
        gitlabProjectId,
        screenshotTitle,
        screenshotWikiContent,
      );
      wikiPages.push(screenshotTitle);
      logger.log(`Screenshot wiki page created: ${screenshotTitle}`);
    } catch (err) {
      logger.warn(`Screenshot wiki page failed: ${err.message}`);
    }
  }

  // Update home page — add feature link
  await updateWikiHome(
    gitlabProjectId,
    projectName,
    issueIid,
    issueTitle,
    featureSlug,
    gitlabService,
    logger,
  );

  // Regenerate sidebar from all existing wiki pages
  await regenerateWikiSidebar(
    gitlabProjectId,
    projectName,
    gitlabService,
    logger,
  );

  return { wikiPages, screenshotWikiContent, screenshotWikiImages };
}

// ─── Screenshot Processing ──────────────────────────────

/**
 * Read the screenshot manifest for an issue, upload PNGs to GitLab,
 * and build a wiki page with embedded images.
 * Returns null if no screenshots exist.
 */
export async function processScreenshots(
  workspace: string,
  issueId: string,
  gitlabProjectId: number,
  issueTitle: string,
  gitlabService: GitlabService,
  logger: Logger,
): Promise<{ wikiContent: string; uploadedFiles: string[] } | null> {
  const manifestPath = path.join(
    workspace,
    '.ui-screenshots',
    issueId,
    'manifest.json',
  );

  try {
    await fs.access(manifestPath);
  } catch {
    return null; // No screenshots for this issue
  }

  const raw = await fs.readFile(manifestPath, 'utf-8');
  const manifest: ScreenshotManifest = JSON.parse(raw);

  if (!manifest.screenshots || manifest.screenshots.length === 0) return null;

  const uploadedFiles: string[] = [];
  const wikiSections: string[] = [
    `# UI Screenshots — ${issueTitle}`,
    '',
    `> Captured: ${manifest.capturedAt}`,
    '',
  ];

  for (const entry of manifest.screenshots) {
    const filePath = path.join(manifest.screenshotDir, entry.file);

    try {
      const fileBuffer = await fs.readFile(filePath);

      // Upload to GitLab
      const uploaded = await gitlabService.uploadProjectFile(
        gitlabProjectId,
        entry.file,
        fileBuffer,
        'image/png',
      );

      uploadedFiles.push(entry.file);

      // Build wiki section for this screenshot
      wikiSections.push(`## ${entry.route} — ${entry.viewport}`);
      wikiSections.push('');
      wikiSections.push(uploaded.markdown);
      wikiSections.push('');

      if (entry.description) {
        wikiSections.push(entry.description);
        wikiSections.push('');
      }

      if (entry.findings?.length) {
        wikiSections.push('**Findings:**');
        for (const finding of entry.findings) {
          wikiSections.push(`- ${finding}`);
        }
        wikiSections.push('');
      }
    } catch (err) {
      logger.warn(`Failed to upload screenshot ${entry.file}: ${err.message}`);
    }
  }

  if (uploadedFiles.length === 0) return null;

  return {
    wikiContent: wikiSections.join('\n'),
    uploadedFiles,
  };
}

// ─── Feature Page Builder ──────────────────────────────────

/**
 * Build the content for a feature wiki subpage.
 */
export function buildFeaturePageContent(
  title: string,
  issueIid: number,
  description: string,
  summary: string,
  changedFiles: string[],
  diffs: any[],
  screenshotContent?: string,
): string {
  const sections: string[] = [
    `# Issue #${issueIid} — ${title}`,
    '',
    `> ${summary}`,
    '',
  ];

  if (description) {
    sections.push('## Description', '', description.substring(0, 2000), '');
  }

  if (changedFiles.length > 0) {
    sections.push('## Documentation Files Changed', '');
    for (const f of changedFiles) {
      sections.push(`- \`${f}\``);
    }
    sections.push('');
  }

  if (diffs.length > 0) {
    sections.push('## Code Changes', '');
    const codeFiles = diffs.slice(0, 30).map((d: any) => {
      const prefix = d.new_file ? 'NEW' : d.deleted_file ? 'DEL' : 'MOD';
      return `- [${prefix}] \`${d.new_path}\``;
    });
    sections.push(...codeFiles, '');
    if (diffs.length > 30) {
      sections.push(`_...and ${diffs.length - 30} more file(s)_`, '');
    }
  }

  if (screenshotContent) {
    sections.push(
      '## Screenshots',
      '',
      `See [UI Screenshots](../UI-Screenshots/Issue-${issueIid})`,
      '',
    );
  }

  sections.push(
    '---',
    `_Documented by VibCode Hub — ${new Date().toISOString().split('T')[0]}_`,
  );
  return sections.join('\n');
}

// ─── Wiki Home Update ──────────────────────────────────────

/**
 * Update the wiki home page — add a link to the new feature.
 */
export async function updateWikiHome(
  gitlabProjectId: number,
  projectName: string,
  issueIid: number,
  issueTitle: string,
  featureSlug: string,
  gitlabService: GitlabService,
  logger: Logger,
): Promise<void> {
  if (!issueIid) return;

  try {
    const existing = await gitlabService.getWikiPageContent(
      gitlabProjectId,
      'home',
    );
    if (!existing) return; // No home page to update

    const featureLink = `- [#${issueIid} ${issueTitle}](Features/Issue-${issueIid}-${featureSlug})`;

    // Check if this feature is already linked
    if (existing.includes(`Issue-${issueIid}-`)) {
      logger.debug(`Feature #${issueIid} already linked in home page`);
      return;
    }

    // Find the Features section and append
    let updated: string;
    if (existing.includes('_No features implemented yet._')) {
      // Replace placeholder with first feature
      updated = existing.replace('_No features implemented yet._', featureLink);
    } else if (existing.includes('## Features')) {
      // Append after the last feature link in the Features section
      const featuresIdx = existing.indexOf('## Features');
      const afterFeatures = existing.substring(featuresIdx);
      // Find the next section header or end of content
      const nextSectionMatch = afterFeatures.substring(14).match(/\n## /);
      const insertPos = nextSectionMatch
        ? featuresIdx + 14 + nextSectionMatch.index!
        : existing.length;

      updated =
        existing.substring(0, insertPos).trimEnd() +
        '\n' +
        featureLink +
        '\n' +
        existing.substring(insertPos);
    } else {
      // No Features section — append at end
      updated = existing + '\n\n## Features\n\n' + featureLink + '\n';
    }

    await gitlabService.upsertWikiPage(gitlabProjectId, 'home', updated);
    logger.log(`Wiki home updated with feature #${issueIid}`);
  } catch (err) {
    logger.warn(`Wiki home update failed (non-fatal): ${err.message}`);
  }
}

// ─── Wiki Sidebar Regeneration ──────────────────────────────

/**
 * Regenerate the _sidebar wiki page from all existing wiki pages.
 * Derives hierarchy from slugs (slashes = directories).
 */
export async function regenerateWikiSidebar(
  gitlabProjectId: number,
  projectName: string,
  gitlabService: GitlabService,
  logger: Logger,
): Promise<void> {
  try {
    const pages = await gitlabService.listWikiPages(gitlabProjectId);
    if (!pages || pages.length === 0) return;

    // Group pages by top-level directory
    const topLevel: string[] = [];
    const grouped: Record<string, Array<{ slug: string; title: string }>> = {};

    for (const page of pages) {
      if (page.slug === '_sidebar') continue; // Skip sidebar itself

      const parts = page.slug.split('/');
      if (parts.length === 1) {
        topLevel.push(page.slug);
      } else {
        const dir = parts[0];
        if (!grouped[dir]) grouped[dir] = [];
        grouped[dir].push({
          slug: page.slug,
          title: parts.slice(1).join('/'),
        });
      }
    }

    const lines: string[] = [`**${projectName}**`, ''];

    // Top-level pages
    for (const slug of topLevel) {
      const displayName = slug === 'home' ? 'Home' : slug.replace(/-/g, ' ');
      lines.push(`- [${displayName}](${slug})`);
    }

    // Grouped sections
    for (const [dir, subpages] of Object.entries(grouped)) {
      lines.push('', `**${dir}**`, '');
      for (const sub of subpages.slice(0, 30)) {
        // Limit to 30 per section
        const displayName = sub.title.replace(/-/g, ' ');
        lines.push(`- [${displayName}](${sub.slug})`);
      }
      if (subpages.length > 30) {
        lines.push(`- _...and ${subpages.length - 30} more_`);
      }
    }

    await gitlabService.upsertWikiPage(
      gitlabProjectId,
      '_sidebar',
      lines.join('\n'),
    );
    logger.log('Wiki sidebar regenerated');
  } catch (err) {
    logger.warn(`Wiki sidebar regeneration failed (non-fatal): ${err.message}`);
  }
}

// ─── Screenshot Cleanup ─────────────────────────────────

/**
 * Remove local screenshots for an issue after they've been uploaded to GitLab.
 * Cleans up `.ui-screenshots/{issueId}/` directory.
 * Also removes the parent `.ui-screenshots/` if empty.
 */
export async function cleanupScreenshots(
  projectId: string,
  issueId: string,
  chatSessionId: string | undefined,
  prisma: PrismaService,
  devopsWorkspacePath: string,
  resolveWorkspace: (slug: string, sessionId: string) => Promise<string>,
  logger: Logger,
): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { slug: true },
    });
    if (!project) return;

    const workspace = chatSessionId
      ? await resolveWorkspace(project.slug, chatSessionId)
      : path.resolve(devopsWorkspacePath, project.slug);

    const screenshotDir = path.join(workspace, '.ui-screenshots', issueId);

    try {
      await fs.access(screenshotDir);
    } catch {
      return; // Directory doesn't exist — nothing to clean
    }

    await fs.rm(screenshotDir, { recursive: true, force: true });
    logger.log(`Cleaned up screenshots: ${screenshotDir}`);

    // Try removing parent .ui-screenshots/ if empty
    const parentDir = path.join(workspace, '.ui-screenshots');
    try {
      const entries = await fs.readdir(parentDir);
      if (entries.length === 0) {
        await fs.rmdir(parentDir);
        logger.log('Removed empty .ui-screenshots/ directory');
      }
    } catch {
      // Parent removal is best-effort
    }
  } catch (err) {
    logger.warn(
      `Screenshot cleanup failed for issue ${issueId}: ${err.message}`,
    );
  }
}

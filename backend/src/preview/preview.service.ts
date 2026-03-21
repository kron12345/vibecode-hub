import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

/** Slug validation: lowercase alphanumeric + hyphens, 2-63 chars */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** Subdomains that must never be used for project previews */
const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'admin',
  'mail',
  'ftp',
  'ns1',
  'ns2',
  'hub',
  'sso',
  'git',
]);

@Injectable()
export class PreviewService implements OnModuleInit {
  private readonly logger = new Logger(PreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /** Sync map file on API startup (recovery) */
  async onModuleInit() {
    if (!this.settings.previewEnabled) {
      this.logger.log('Preview system disabled');
      return;
    }
    try {
      await this.syncNginxMap();
      this.logger.log('Nginx map file synchronized on startup');
    } catch (err) {
      this.logger.warn(`Map sync on startup failed: ${err.message}`);
    }
  }

  /** Full flow: allocate port → sync map → reload nginx → return URL */
  async setupPreview(projectId: string): Promise<string | null> {
    if (!this.settings.previewEnabled) {
      this.logger.log('Preview disabled, skipping setup');
      return null;
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      this.logger.warn(`Project not found: ${projectId}`);
      return null;
    }

    // Validate slug
    if (!this.isValidSlug(project.slug)) {
      this.logger.warn(`Invalid slug for preview: "${project.slug}"`);
      return null;
    }

    // Allocate port if not already assigned
    if (!project.previewPort) {
      const port = await this.allocatePort(projectId);
      if (!port) return null;
    }

    // Sync map file and reload nginx
    await this.syncNginxMap();
    await this.reloadNginx();

    const updated = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    const domain = this.settings.previewDomain;
    const url = `https://${updated!.slug}.${domain}`;

    this.logger.log(`Preview setup: ${url} (port ${updated!.previewPort})`);
    return url;
  }

  /** Remove preview: clear port → sync map → reload nginx */
  async teardownPreview(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project?.previewPort) return;

    await this.prisma.project.update({
      where: { id: projectId },
      data: { previewPort: null },
    });

    this.logger.log(
      `Preview port released: ${project.slug} (was ${project.previewPort})`,
    );

    try {
      await this.syncNginxMap();
      await this.reloadNginx();
    } catch (err) {
      this.logger.warn(`Teardown nginx sync failed: ${err.message}`);
    }
  }

  /**
   * Find next free port from the configured range and assign it.
   * The @unique constraint on previewPort protects against race conditions.
   */
  async allocatePort(projectId: string): Promise<number | null> {
    const min = this.settings.previewPortMin;
    const max = this.settings.previewPortMax;

    // Get all used ports
    const usedPorts = await this.prisma.project.findMany({
      where: { previewPort: { not: null } },
      select: { previewPort: true },
    });
    const usedSet = new Set(usedPorts.map((p) => p.previewPort));

    // Find first free port
    let port: number | null = null;
    for (let p = min; p <= max; p++) {
      if (!usedSet.has(p)) {
        port = p;
        break;
      }
    }

    if (port === null) {
      this.logger.error(`No free preview ports in range ${min}-${max}`);
      return null;
    }

    try {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { previewPort: port },
      });
      this.logger.log(`Port ${port} allocated to project ${projectId}`);
      return port;
    } catch (err) {
      // Unique constraint violation — retry once with fresh port list
      this.logger.warn(`Port allocation conflict, retrying: ${err.message}`);
      return this.allocatePort(projectId);
    }
  }

  /**
   * Regenerate the complete nginx map file from DB.
   * Uses temp-file + sudo cp for atomic write.
   */
  async syncNginxMap(): Promise<void> {
    const mapPath = this.settings.previewNginxMapPath;

    // Get all projects with a preview port
    const projects = await this.prisma.project.findMany({
      where: { previewPort: { not: null } },
      select: { slug: true, previewPort: true },
      orderBy: { slug: 'asc' },
    });

    // Build map file content
    const entries = projects
      .filter((p) => this.isValidSlug(p.slug))
      .map((p) => `  ${p.slug} "127.0.0.1:${p.previewPort}";`)
      .join('\n');

    const content = [
      '# Auto-generated by VibCode Hub — DO NOT EDIT',
      'map $hub_project $hub_upstream {',
      '  default "";',
      entries,
      '}',
      '',
    ].join('\n');

    // Write to temp file, then sudo cp to target
    const tmpPath = join(tmpdir(), `hub-project-map-${Date.now()}.conf`);

    try {
      await writeFile(tmpPath, content, 'utf-8');
      await execFileAsync('sudo', ['cp', tmpPath, mapPath]);
      this.logger.log(
        `Nginx map synced: ${projects.length} entries → ${mapPath}`,
      );
    } finally {
      // Clean up temp file (ignore errors)
      try {
        await unlink(tmpPath);
      } catch {
        /* noop */
      }
    }
  }

  /** Test nginx config then reload */
  async reloadNginx(): Promise<void> {
    // Test config first
    const { stderr: testErr } = await execFileAsync('sudo', ['nginx', '-t']);
    if (testErr && !testErr.includes('syntax is ok')) {
      throw new Error(`Nginx config test failed: ${testErr}`);
    }

    // Reload
    await execFileAsync('sudo', ['nginx', '-s', 'reload']);
    this.logger.log('Nginx reloaded');
  }

  /** Validate slug for subdomain use */
  private isValidSlug(slug: string): boolean {
    if (!slug || slug.length < 2 || slug.length > 63) return false;
    if (!SLUG_REGEX.test(slug)) return false;
    if (RESERVED_SUBDOMAINS.has(slug)) return false;
    return true;
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { Public } from '../common/decorators/public.decorator';

interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptime: number;
  checks: {
    database: { status: 'ok' | 'down'; latencyMs?: number; error?: string };
    keycloak: { status: 'ok' | 'down' | 'unconfigured'; url?: string };
    gitlab: { status: 'ok' | 'down' | 'unconfigured'; url?: string };
    ollama: { status: 'ok' | 'down' | 'unconfigured'; url?: string };
  };
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check — DB, Keycloak, GitLab, Ollama' })
  async check(): Promise<HealthStatus> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkKeycloak(),
      this.checkGitlab(),
      this.checkOllama(),
    ]);

    const [database, keycloak, gitlab, ollama] = checks;

    const anyDown = [database, keycloak, gitlab].some(
      (c) => c.status === 'down',
    );
    const allOk = [database, keycloak, gitlab, ollama].every(
      (c) => c.status === 'ok' || c.status === 'unconfigured',
    );

    return {
      status: anyDown ? 'degraded' : allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: { database, keycloak, gitlab, ollama },
    };
  }

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe (always 200 if process is running)' })
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (200 if DB is reachable)' })
  async ready() {
    const db = await this.checkDatabase();
    if (db.status === 'down') {
      return { status: 'not_ready', reason: db.error };
    }
    return { status: 'ready' };
  }

  private async checkDatabase(): Promise<{
    status: 'ok' | 'down';
    latencyMs?: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return { status: 'down', error: err.message };
    }
  }

  private async checkKeycloak(): Promise<{
    status: 'ok' | 'down' | 'unconfigured';
    url?: string;
  }> {
    const url = process.env.KEYCLOAK_URL;
    if (!url) return { status: 'unconfigured' };

    try {
      const realm = process.env.KEYCLOAK_REALM ?? 'vibcodehub';
      const response = await fetch(
        `${url}/realms/${realm}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(5000) },
      );
      return { status: response.ok ? 'ok' : 'down', url };
    } catch {
      return { status: 'down', url };
    }
  }

  private async checkGitlab(): Promise<{
    status: 'ok' | 'down' | 'unconfigured';
    url?: string;
  }> {
    const url = this.settings.get('gitlab.url', '', '');
    if (!url) return { status: 'unconfigured' };

    try {
      const response = await fetch(`${url}/api/v4/version`, {
        headers: {
          'PRIVATE-TOKEN': this.settings.get('gitlab.token', '', ''),
        },
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.ok ? 'ok' : 'down', url };
    } catch {
      return { status: 'down', url };
    }
  }

  private async checkOllama(): Promise<{
    status: 'ok' | 'down' | 'unconfigured';
    url?: string;
  }> {
    const url = this.settings.get('ollama.url', '', '');
    if (!url) return { status: 'unconfigured' };

    try {
      const response = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return { status: response.ok ? 'ok' : 'down', url };
    } catch {
      return { status: 'down', url };
    }
  }
}

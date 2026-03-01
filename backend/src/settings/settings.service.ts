import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt, maskSecret } from './crypto.util';
import { UpsertSystemSettingDto } from './settings.dto';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  private get encryptionKey(): string {
    return this.config.get<string>('KEYCLOAK_CLIENT_SECRET', '');
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─── User Settings ──────────────────────────────────────────

  async getUserSettings(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.userSetting.findMany({
      where: { userId },
    });

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  async upsertUserSetting(
    userId: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.prisma.userSetting.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value },
      update: { value },
    });
  }

  async bulkUpsertUserSettings(
    userId: string,
    settings: { key: string; value: string }[],
  ): Promise<void> {
    await this.prisma.$transaction(
      settings.map((s) =>
        this.prisma.userSetting.upsert({
          where: { userId_key: { userId, key: s.key } },
          create: { userId, key: s.key, value: s.value },
          update: { value: s.value },
        }),
      ),
    );
  }

  // ─── System Settings ────────────────────────────────────────

  async getAllSystemSettings(): Promise<
    Array<{
      key: string;
      value: string;
      category: string;
      encrypted: boolean;
      description: string | null;
    }>
  > {
    const rows = await this.prisma.systemSetting.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });

    return rows.map((row) => ({
      key: row.key,
      value: row.encrypted
        ? maskSecret(this.decryptValue(row.value))
        : row.value,
      category: row.category,
      encrypted: row.encrypted,
      description: row.description,
    }));
  }

  async getSystemSettingsByCategory(category: string) {
    const rows = await this.prisma.systemSetting.findMany({
      where: { category },
      orderBy: { key: 'asc' },
    });

    return rows.map((row) => ({
      key: row.key,
      value: row.encrypted
        ? maskSecret(this.decryptValue(row.value))
        : row.value,
      category: row.category,
      encrypted: row.encrypted,
      description: row.description,
    }));
  }

  /** Get raw (decrypted) value — only for internal use */
  async getSystemSettingRaw(key: string): Promise<string | null> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key },
    });
    if (!row) return null;
    return row.encrypted ? this.decryptValue(row.value) : row.value;
  }

  async upsertSystemSetting(dto: UpsertSystemSettingDto): Promise<void> {
    const value =
      dto.encrypted && dto.value
        ? encrypt(dto.value, this.encryptionKey)
        : dto.value;

    await this.prisma.systemSetting.upsert({
      where: { key: dto.key },
      create: {
        key: dto.key,
        value,
        category: dto.category ?? dto.key.split('.')[0],
        encrypted: dto.encrypted ?? false,
        description: dto.description ?? null,
      },
      update: {
        value,
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.encrypted !== undefined && { encrypted: dto.encrypted }),
        ...(dto.description !== undefined && { description: dto.description }),
      },
    });
  }

  async bulkUpsertSystemSettings(
    settings: UpsertSystemSettingDto[],
  ): Promise<void> {
    for (const dto of settings) {
      await this.upsertSystemSetting(dto);
    }
  }

  // ─── Private ─────────────────────────────────────────────────

  private decryptValue(encrypted: string): string {
    if (!encrypted) return '';
    try {
      return decrypt(encrypted, this.encryptionKey);
    } catch (e) {
      this.logger.warn(`Failed to decrypt setting value: ${e.message}`);
      return '';
    }
  }
}

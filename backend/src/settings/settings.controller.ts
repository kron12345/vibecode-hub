import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { SystemSettingsService } from './system-settings.service';
import { ProviderDiscoveryService } from './provider-discovery.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  UpsertUserSettingDto,
  BulkUpsertUserSettingsDto,
  BulkUpsertSystemSettingsDto,
} from './settings.dto';
import { AGENT_PRESETS } from './agent-presets';

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly providerDiscovery: ProviderDiscoveryService,
  ) {}

  // ─── User Settings ──────────────────────────────────────────

  @Get('user')
  @ApiOperation({ summary: 'Get own user settings' })
  async getUserSettings(@Req() req: any) {
    return this.settingsService.getUserSettings(req.user.id);
  }

  @Put('user')
  @ApiOperation({ summary: 'Bulk upsert own user settings' })
  async bulkUpsertUserSettings(
    @Req() req: any,
    @Body() dto: BulkUpsertUserSettingsDto,
  ) {
    await this.settingsService.bulkUpsertUserSettings(req.user.id, dto.settings);
    return this.settingsService.getUserSettings(req.user.id);
  }

  @Put('user/:key')
  @ApiOperation({ summary: 'Upsert a single user setting' })
  async upsertUserSetting(
    @Req() req: any,
    @Param('key') key: string,
    @Body() dto: UpsertUserSettingDto,
  ) {
    await this.settingsService.upsertUserSetting(req.user.id, key, dto.value);
    return { key, value: dto.value };
  }

  // ─── System Settings (Admin only) ───────────────────────────

  @Get('system')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get all system settings (admin)' })
  async getSystemSettings() {
    return this.settingsService.getAllSystemSettings();
  }

  @Get('system/:category')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get system settings by category (admin)' })
  async getSystemSettingsByCategory(@Param('category') category: string) {
    return this.settingsService.getSystemSettingsByCategory(category);
  }

  @Put('system')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Bulk upsert system settings (admin)' })
  async bulkUpsertSystemSettings(@Body() dto: BulkUpsertSystemSettingsDto) {
    await this.settingsService.bulkUpsertSystemSettings(dto.settings);
    await this.systemSettingsService.refreshCache();
    return this.settingsService.getAllSystemSettings();
  }

  // ─── Agent Role Configs ───────────────────────────────────

  @Get('agents/roles')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get all agent role configurations (admin)' })
  async getAgentRoleConfigs() {
    return this.systemSettingsService.getAllAgentRoleConfigs();
  }

  @Get('agents/pipeline')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get pipeline configuration (admin)' })
  async getPipelineConfig() {
    return this.systemSettingsService.getPipelineConfig();
  }

  // ─── Agent Presets ───────────────────────────────────────

  @Get('agents/presets')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get available agent presets (admin)' })
  async getAgentPresets() {
    return Object.entries(AGENT_PRESETS).map(([id, preset]) => ({
      id,
      name: preset.name,
      description: preset.description,
      icon: preset.icon,
    }));
  }

  @Post('agents/presets/:presetId')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Apply an agent preset to all roles (admin)' })
  async applyAgentPreset(@Param('presetId') presetId: string) {
    const preset = AGENT_PRESETS[presetId];
    if (!preset) {
      throw new NotFoundException(`Preset "${presetId}" not found. Available: ${Object.keys(AGENT_PRESETS).join(', ')}`);
    }

    // Load current configs, merge preset overrides (keep prompts, permissions, meta)
    const currentConfigs = this.systemSettingsService.getAllAgentRoleConfigs();
    const settings: { key: string; value: string; category: string }[] = [];

    for (const [role, override] of Object.entries(preset.roles)) {
      const current = currentConfigs[role];
      if (!current) continue;

      const merged = {
        ...current,
        provider: override.provider,
        model: override.model,
        parameters: {
          ...current.parameters,
          temperature: override.temperature,
          maxTokens: override.maxTokens,
        },
      };

      settings.push({
        key: `agents.roles.${role}`,
        value: JSON.stringify(merged),
        category: 'agents',
      });
    }

    await this.settingsService.bulkUpsertSystemSettings(settings);
    await this.systemSettingsService.refreshCache();

    return {
      presetId,
      name: preset.name,
      rolesUpdated: settings.length,
    };
  }

  // ─── Provider Discovery ───────────────────────────────────

  @Get('providers/models')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Discover available models for all providers (admin)' })
  async getAllProviderModels() {
    return this.providerDiscovery.discoverAllModels();
  }

  @Get('providers/ollama/models')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Discover available Ollama models (admin)' })
  async getOllamaModels() {
    return this.providerDiscovery.discoverOllamaModels();
  }

  @Get('providers/ollama/health')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Check Ollama health (admin)' })
  async checkOllamaHealth() {
    const healthy = await this.providerDiscovery.checkOllamaHealth();
    return { healthy, url: this.systemSettingsService.ollamaUrl };
  }

  @Get('providers/cli/status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Detect installed CLI tools (admin)' })
  async getCliToolStatus() {
    return this.providerDiscovery.detectCliTools();
  }
}

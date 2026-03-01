import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  Req,
  UseGuards,
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

  // ─── Provider Discovery ───────────────────────────────────

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

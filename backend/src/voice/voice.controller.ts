import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { VoiceService } from './voice.service';

@ApiTags('voice')
@ApiBearerAuth()
@Controller('voice')
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  @Get('health')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Check STT and TTS service health' })
  async getHealth() {
    return this.voiceService.checkHealth();
  }

  @Get('config')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get current voice configuration' })
  getConfig() {
    return this.voiceService.getConfig();
  }

  @Get('voices')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List available TTS voices from the active engine' })
  async getVoices() {
    return this.voiceService.listVoices();
  }
}

import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { TelegramService } from './telegram.service';

export class ValidateTokenDto {
  @IsString()
  token: string;
}

export class SaveTelegramConfigDto {
  @IsString()
  botToken: string;

  @IsString()
  chatId: string;

  @IsOptional()
  @IsBoolean()
  notifyClarifications?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyResults?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyErrors?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyStatus?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyAll?: boolean;
}

@ApiTags('telegram')
@Controller('telegram')
@UseGuards(RolesGuard)
@Roles('admin')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Post('validate-token')
  @ApiOperation({ summary: 'Validate a Telegram bot token via Bot API' })
  async validateToken(@Body() dto: ValidateTokenDto) {
    return this.telegram.validateToken(dto.token);
  }

  @Post('detect-chat-id')
  @ApiOperation({ summary: 'Auto-detect chat ID from recent messages to the bot' })
  async detectChatId(@Body() dto: ValidateTokenDto) {
    return this.telegram.detectChatId(dto.token);
  }

  @Post('send-test')
  @ApiOperation({ summary: 'Send a test message to verify the connection' })
  async sendTest(@Body() dto: SaveTelegramConfigDto) {
    return this.telegram.sendTestMessage(dto.botToken, dto.chatId);
  }

  @Post('save')
  @ApiOperation({ summary: 'Save Telegram configuration to system settings' })
  async saveConfig(@Body() dto: SaveTelegramConfigDto) {
    return this.telegram.saveConfig(dto);
  }

  @Get('config')
  @ApiOperation({ summary: 'Get current Telegram configuration' })
  async getConfig() {
    return this.telegram.getConfig();
  }
}

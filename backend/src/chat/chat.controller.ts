import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiQuery } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { CreateChatSessionDto, SendMessageDto } from './chat.dto';

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // ─── Sessions ────────────────────────────────────────────────

  @Get('sessions')
  @ApiQuery({ name: 'projectId', required: true })
  findSessions(@Query('projectId') projectId: string) {
    return this.chatService.findSessionsByProject(projectId);
  }

  @Get('sessions/:id')
  findSession(@Param('id') id: string) {
    return this.chatService.findSessionById(id);
  }

  @Post('sessions')
  createSession(@Body() dto: CreateChatSessionDto) {
    return this.chatService.createSession(dto);
  }

  @Delete('sessions/:id')
  deleteSession(@Param('id') id: string) {
    return this.chatService.deleteSession(id);
  }

  // ─── Messages ────────────────────────────────────────────────

  @Get('sessions/:id/messages')
  getMessages(@Param('id') id: string) {
    return this.chatService.getMessages(id);
  }

  @Post('messages')
  sendMessage(@Body() dto: SendMessageDto) {
    return this.chatService.addMessage(dto);
  }
}

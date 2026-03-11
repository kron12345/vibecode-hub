import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiQuery, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChatSessionType, MessageRole } from '@prisma/client';
import { ChatService } from './chat.service';
import { SessionBranchService } from './session-branch.service';
import { CreateChatSessionDto, CreateDevSessionDto, UpdateSessionDto, SendMessageDto } from './chat.dto';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
];

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly sessionBranch: SessionBranchService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Sessions ────────────────────────────────────────────────

  @Get('sessions')
  @ApiQuery({ name: 'projectId', required: true })
  @ApiQuery({ name: 'type', required: false, enum: ChatSessionType })
  findSessions(
    @Query('projectId') projectId: string,
    @Query('type') type?: ChatSessionType,
  ) {
    return this.chatService.findSessionsByProject(projectId, type);
  }

  @Get('sessions/archived')
  @ApiQuery({ name: 'projectId', required: true })
  getArchivedSessions(@Query('projectId') projectId: string) {
    return this.chatService.getArchivedSessions(projectId);
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

  // ─── Dev Sessions (Branching) ───────────────────────────────

  @Post('sessions/dev')
  createDevSession(@Body() dto: CreateDevSessionDto) {
    return this.sessionBranch.createDevSession(dto.projectId, dto.title, dto.branch);
  }

  @Post('sessions/:id/archive')
  archiveSession(@Param('id') id: string) {
    return this.sessionBranch.archiveSession(id);
  }

  @Post('sessions/:id/resolve')
  resolveConflict(@Param('id') id: string) {
    return this.sessionBranch.resolveConflict(id);
  }

  @Post('sessions/:id/continue')
  continueSession(@Param('id') id: string) {
    return this.sessionBranch.continueSession(id);
  }

  @Patch('sessions/:id')
  updateSession(@Param('id') id: string, @Body() dto: UpdateSessionDto) {
    return this.sessionBranch.updateSession(id, dto);
  }

  // ─── Messages ────────────────────────────────────────────────

  @Get('sessions/:id/messages')
  getMessages(@Param('id') id: string) {
    return this.chatService.getMessages(id);
  }

  @Post('messages')
  async sendMessage(@Body() dto: SendMessageDto) {
    const message = await this.chatService.addMessage(dto);

    // Emit event for agent orchestration (same as WebSocket gateway)
    if (dto.role === 'USER') {
      this.eventEmitter.emit('chat.userMessage', {
        chatSessionId: dto.chatSessionId,
        content: dto.content,
      });
    }

    return message;
  }

  // ─── File Upload ────────────────────────────────────────────

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new BadRequestException(`File type ${file.mimetype} not allowed. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`), false);
      }
    },
  }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        chatSessionId: { type: 'string' },
      },
    },
  })
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('chatSessionId') chatSessionId: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!chatSessionId) throw new BadRequestException('chatSessionId is required');

    this.logger.log(`File upload: ${file.originalname} (${file.mimetype}, ${file.size} bytes) for session ${chatSessionId}`);

    // Extract text content based on file type
    let extractedText = '';
    const isPdf = file.mimetype === 'application/pdf';
    const isImage = file.mimetype.startsWith('image/');
    const isText = file.mimetype.startsWith('text/');

    if (isPdf) {
      try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: file.buffer });
        const textResult = await parser.getText();
        extractedText = textResult?.text?.trim() ?? '';
        this.logger.log(`PDF parsed: ${extractedText.length} chars extracted`);
      } catch (err) {
        this.logger.warn(`PDF parse failed: ${err.message}`);
        extractedText = '[PDF parsing failed — please describe the content manually]';
      }
    } else if (isText) {
      extractedText = file.buffer.toString('utf-8').trim();
    }
    // Images: no text extraction, will be described by multimodal LLM or user

    // Build chat message content
    const displayContent = isPdf
      ? `📄 **Uploaded:** ${file.originalname} (${Math.ceil(file.size / 1024)} KB, ${extractedText ? `${extractedText.length} chars extracted` : 'no text'})`
      : isImage
        ? `🖼️ **Uploaded:** ${file.originalname} (${Math.ceil(file.size / 1024)} KB)`
        : `📎 **Uploaded:** ${file.originalname} (${Math.ceil(file.size / 1024)} KB)`;

    // Truncate extracted text for the context (max 15k chars to fit in LLM context)
    const truncatedText = extractedText.length > 15000
      ? extractedText.substring(0, 15000) + '\n\n[... truncated, document too long ...]'
      : extractedText;

    // Build metadata
    const metadata: Record<string, unknown> = {
      type: 'file',
      filename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    };

    if (truncatedText) {
      metadata.extractedText = truncatedText;
    }

    if (isImage) {
      // Store base64 for multimodal LLM (images are usually small enough)
      metadata.imageBase64 = file.buffer.toString('base64');
    }

    // Save as USER message with file metadata
    const message = await this.chatService.addMessage({
      chatSessionId,
      role: MessageRole.USER,
      content: displayContent,
      metadata,
    });

    // Trigger agent processing (same as regular user message)
    this.eventEmitter.emit('chat.userMessage', {
      chatSessionId,
      content: truncatedText
        ? `[User uploaded file: ${file.originalname}]\n\nExtracted content:\n${truncatedText}`
        : `[User uploaded file: ${file.originalname}] (${isImage ? 'image — please describe what you see or what this relates to' : 'no extractable text'})`,
    });

    return message;
  }
}

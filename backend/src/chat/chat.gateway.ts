import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { VoiceService } from '../voice/voice.service';
import { MessageRole } from '@prisma/client';

// Note: WebSocket CORS is set via decorator at startup.
// Changes to CORS origins in settings require an API restart.
@WebSocketGateway({
  cors: {
    origin: ['https://hub.example.com', 'http://localhost:4200'],
    credentials: true,
  },
  namespace: '/chat',
  maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB for audio uploads
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  /** Track which sessions have voice-mode clients: sessionId → Set<clientId> */
  private voiceClients = new Map<string, Set<string>>();

  constructor(
    private readonly chatService: ChatService,
    private readonly eventEmitter: EventEmitter2,
    private readonly voiceService: VoiceService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Clean up voice tracking for this client
    for (const [sessionId, clients] of this.voiceClients) {
      clients.delete(client.id);
      if (clients.size === 0) {
        this.voiceClients.delete(sessionId);
      }
    }
  }

  @SubscribeMessage('joinSession')
  handleJoinSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatSessionId: string },
  ) {
    client.join(`session:${data.chatSessionId}`);
    this.logger.debug(`Client ${client.id} joined session ${data.chatSessionId}`);
  }

  @SubscribeMessage('leaveSession')
  handleLeaveSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatSessionId: string },
  ) {
    client.leave(`session:${data.chatSessionId}`);
    // Also remove from voice tracking
    this.voiceClients.get(data.chatSessionId)?.delete(client.id);
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatSessionId: string; content: string },
  ) {
    const message = await this.chatService.addMessage({
      chatSessionId: data.chatSessionId,
      role: MessageRole.USER,
      content: data.content,
    });

    // Broadcast to all clients in the session room
    this.server
      .to(`session:${data.chatSessionId}`)
      .emit('newMessage', message);

    // Emit event for agent orchestration (non-blocking)
    this.eventEmitter.emit('chat.userMessage', {
      chatSessionId: data.chatSessionId,
      content: data.content,
    });

    return message;
  }

  // ─── Voice Events ───────────────────────────────────────────

  @SubscribeMessage('voiceModeToggle')
  handleVoiceModeToggle(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatSessionId: string; enabled: boolean },
  ) {
    const { chatSessionId, enabled } = data;

    if (enabled) {
      if (!this.voiceClients.has(chatSessionId)) {
        this.voiceClients.set(chatSessionId, new Set());
      }
      this.voiceClients.get(chatSessionId)!.add(client.id);
      this.logger.log(`Voice mode ON for session ${chatSessionId} (client ${client.id})`);
    } else {
      this.voiceClients.get(chatSessionId)?.delete(client.id);
      if (this.voiceClients.get(chatSessionId)?.size === 0) {
        this.voiceClients.delete(chatSessionId);
      }
      this.logger.log(`Voice mode OFF for session ${chatSessionId} (client ${client.id})`);
    }
  }

  @SubscribeMessage('voiceMessage')
  async handleVoiceMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatSessionId: string; audio: string; mimeType: string },
  ) {
    const { chatSessionId, audio, mimeType } = data;

    try {
      // 1. Decode base64 audio
      const audioBuffer = Buffer.from(audio, 'base64');
      this.logger.debug(`Voice: received ${audioBuffer.length} bytes from client ${client.id}`);

      // 2. Transcribe via STT
      const transcription = await this.voiceService.transcribe(audioBuffer, mimeType);

      if (!transcription.text) {
        this.server.to(`session:${chatSessionId}`).emit('voiceError', {
          chatSessionId,
          error: 'No speech detected',
        });
        return;
      }

      // Check room membership
      const roomName = `session:${chatSessionId}`;
      const roomSockets = await this.server.in(roomName).fetchSockets();
      this.logger.debug(`Voice: room ${chatSessionId.slice(-8)} has ${roomSockets.length} clients`);

      // 3. Send transcript to client
      this.server.to(`session:${chatSessionId}`).emit('voiceTranscript', {
        chatSessionId,
        text: transcription.text,
        language: transcription.language,
        isFinal: true,
      });

      // 4. Save as normal text message
      this.logger.debug(`Voice: saving message to DB...`);
      const message = await this.chatService.addMessage({
        chatSessionId,
        role: MessageRole.USER,
        content: transcription.text,
      });
      this.logger.debug(`Voice: message saved (id=${message.id})`);

      // 5. Broadcast message
      this.server.to(`session:${chatSessionId}`).emit('newMessage', message);

      // 6. Trigger agent flow
      this.logger.debug(`Voice: triggering agent flow`);
      this.eventEmitter.emit('chat.userMessage', {
        chatSessionId,
        content: transcription.text,
      });
    } catch (error) {
      this.logger.error(`Voice message failed: ${error?.message ?? error}`, error?.stack);
      this.server.to(`session:${chatSessionId}`).emit('voiceError', {
        chatSessionId,
        error: error?.message ?? 'Unknown voice error',
      });
    }
  }

  /** Emit a message to all clients in a session (used by agents/services) */
  emitToSession(chatSessionId: string, event: string, data: any) {
    this.server.to(`session:${chatSessionId}`).emit(event, data);

    // Auto-TTS: When an agent message arrives and voice clients are active
    if (event === 'newMessage' && data?.role && data.role !== 'USER' && data.content) {
      const hasVoice = this.hasVoiceClients(chatSessionId);
      this.logger.debug(
        `Auto-TTS check: session=${chatSessionId.slice(-8)} role=${data.role} hasVoice=${hasVoice} contentLen=${data.content?.length}`,
      );
      if (hasVoice) {
        this.logger.log(`Auto-TTS triggering for session ${chatSessionId.slice(-8)}`);
        this.streamTtsToSession(chatSessionId, data.content).catch((err) => {
          this.logger.error(`Auto-TTS failed: ${err.message}`);
        });
      }
    }
  }

  /** Check if a session has active voice-mode clients */
  hasVoiceClients(chatSessionId: string): boolean {
    return (this.voiceClients.get(chatSessionId)?.size ?? 0) > 0;
  }

  /** Stream TTS audio to all voice clients in a session */
  private async streamTtsToSession(
    chatSessionId: string,
    text: string,
  ): Promise<void> {
    const room = `session:${chatSessionId}`;

    // Strip markdown formatting for cleaner TTS
    const cleanText = text
      .replace(/```[\s\S]*?```/g, '') // code blocks
      .replace(/`[^`]+`/g, '') // inline code
      .replace(/[#*_~>\[\]()!]/g, '') // markdown chars
      .replace(/\n{2,}/g, '. ') // paragraph breaks → pause
      .replace(/\n/g, ' ')
      .trim();

    if (!cleanText) return;

    try {
      this.server.to(room).emit('voiceAudioStart', {
        chatSessionId,
        format: 'audio/wav',
      });

      let chunkIndex = 0;
      for await (const chunk of this.voiceService.synthesizeStream(cleanText)) {
        this.server.to(room).emit('voiceAudioChunk', {
          chatSessionId,
          audio: chunk.toString('base64'),
          chunkIndex: chunkIndex++,
        });
      }

      this.server.to(room).emit('voiceAudioEnd', {
        chatSessionId,
      });
    } catch (error) {
      this.logger.error(`TTS streaming failed: ${error.message}`);
      this.server.to(room).emit('voiceError', {
        chatSessionId,
        error: `TTS failed: ${error.message}`,
      });
    }
  }
}

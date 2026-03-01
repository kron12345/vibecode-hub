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
import { MessageRole } from '@prisma/client';

// Note: WebSocket CORS is set via decorator at startup.
// Changes to CORS origins in settings require an API restart.
@WebSocketGateway({
  cors: {
    origin: ['https://hub.example.com', 'http://localhost:4200'],
    credentials: true,
  },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
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

  /** Emit a message to all clients in a session (used by agents/services) */
  emitToSession(chatSessionId: string, event: string, data: any) {
    this.server.to(`session:${chatSessionId}`).emit(event, data);
  }
}

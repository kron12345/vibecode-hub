import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { HardwareService, HardwareSnapshot } from './hardware.service';

@WebSocketGateway({
  cors: {
    origin: ['https://hub.example.com', 'http://localhost:4200'],
    credentials: true,
  },
  namespace: '/monitor',
})
export class MonitorGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MonitorGateway.name);
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly hardwareService: HardwareService) {}

  afterInit() {
    // Subscribe to hardware snapshots and push to all connected clients
    this.unsubscribe = this.hardwareService.onSnapshot((snapshot) => {
      this.server.emit('hardwareStats', snapshot);
    });
    this.logger.log('Monitor WebSocket gateway initialized');
  }

  handleConnection(client: Socket) {
    this.logger.debug(`Monitor client connected: ${client.id}`);

    // Send latest snapshot + history immediately on connect
    const latest = this.hardwareService.getLatest();
    if (latest) {
      client.emit('hardwareStats', latest);
    }
    const history = this.hardwareService.getHistory();
    if (history.length > 0) {
      client.emit('hardwareHistory', history);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Monitor client disconnected: ${client.id}`);
  }

  /** Join a project-specific log room */
  @SubscribeMessage('joinLogRoom')
  handleJoinLogRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId?: string },
  ) {
    const room = data.projectId
      ? `logs:project:${data.projectId}`
      : 'logs:all';
    client.join(room);
    this.logger.debug(`Client ${client.id} joined ${room}`);
  }

  /** Leave a log room */
  @SubscribeMessage('leaveLogRoom')
  handleLeaveLogRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId?: string },
  ) {
    const room = data.projectId
      ? `logs:project:${data.projectId}`
      : 'logs:all';
    client.leave(room);
  }

  /** Emit an agent log entry to relevant rooms */
  emitLogEntry(projectId: string, logEntry: Record<string, any>) {
    this.server
      .to(`logs:project:${projectId}`)
      .to('logs:all')
      .emit('agentLogEntry', logEntry);
  }

  /** Emit an LLM call event to relevant rooms */
  emitLlmCall(projectId: string | null, callData: Record<string, any>) {
    if (projectId) {
      this.server
        .to(`logs:project:${projectId}`)
        .to('logs:all')
        .emit('llmCall', callData);
    } else {
      this.server.to('logs:all').emit('llmCall', callData);
    }
  }
}

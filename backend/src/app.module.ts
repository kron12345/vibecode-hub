import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { SettingsModule } from './settings/settings.module';
import { ProjectsModule } from './projects/projects.module';
import { GitlabModule } from './gitlab/gitlab.module';
import { IssuesModule } from './issues/issues.module';
import { ChatModule } from './chat/chat.module';
import { LlmModule } from './llm/llm.module';
import { McpModule } from './mcp/mcp.module';
import { AgentsModule } from './agents/agents.module';
import { PreviewModule } from './preview/preview.module';
import { MonitorModule } from './monitor/monitor.module';
import { VoiceModule } from './voice/voice.module';
import { HttpLoggingMiddleware } from './common/http-logging.middleware';
import { AuditLogService } from './common/audit-log.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,   // 1 second
        limit: 10,   // max 10 requests per second
      },
      {
        name: 'medium',
        ttl: 60000,  // 1 minute
        limit: 60,   // max 60 requests per minute
      },
    ]),
    PrismaModule,
    AuthModule,
    SettingsModule,
    ProjectsModule,
    GitlabModule,
    IssuesModule,
    ChatModule,
    LlmModule,
    McpModule,
    AgentsModule,
    PreviewModule,
    MonitorModule,
    VoiceModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    AuditLogService,
  ],
  exports: [AuditLogService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpLoggingMiddleware).forRoutes('*');
  }
}

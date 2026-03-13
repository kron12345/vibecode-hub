import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
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
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { VoiceModule } from '../voice/voice.module';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { SessionBranchService } from './session-branch.service';

@Module({
  imports: [GitlabModule, VoiceModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, SessionBranchService],
  exports: [ChatService, ChatGateway, SessionBranchService],
})
export class ChatModule {}

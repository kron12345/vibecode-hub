import { Global, Module } from '@nestjs/common';
import { McpClientService } from './mcp-client.service';
import { McpAgentLoopService } from './mcp-agent-loop.service';

@Global()
@Module({
  providers: [McpClientService, McpAgentLoopService],
  exports: [McpClientService, McpAgentLoopService],
})
export class McpModule {}

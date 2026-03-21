import { Global, Module } from '@nestjs/common';
import { McpClientService } from './mcp-client.service';
import { McpAgentLoopService } from './mcp-agent-loop.service';
import { McpRegistryService } from './mcp-registry.service';
import {
  McpRegistryController,
  McpProjectOverrideController,
} from './mcp-registry.controller';

@Global()
@Module({
  controllers: [McpRegistryController, McpProjectOverrideController],
  providers: [McpClientService, McpAgentLoopService, McpRegistryService],
  exports: [McpClientService, McpAgentLoopService, McpRegistryService],
})
export class McpModule {}

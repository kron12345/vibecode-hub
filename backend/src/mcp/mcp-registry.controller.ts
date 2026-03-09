import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { McpRegistryService } from './mcp-registry.service';
import { CreateMcpServerDto, UpdateMcpServerDto, SetRoleAssignmentsDto } from './mcp-registry.dto';

@ApiTags('mcp-servers')
@ApiBearerAuth()
@Controller('mcp-servers')
@UseGuards(RolesGuard)
@Roles('admin')
export class McpRegistryController {
  constructor(private readonly registry: McpRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'List all MCP server definitions with role assignments' })
  async findAll() {
    return this.registry.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single MCP server definition' })
  async findOne(@Param('id') id: string) {
    return this.registry.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a custom MCP server definition' })
  async create(@Body() dto: CreateMcpServerDto) {
    return this.registry.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an MCP server definition' })
  async update(@Param('id') id: string, @Body() dto: UpdateMcpServerDto) {
    return this.registry.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a custom MCP server (built-in cannot be deleted)' })
  async delete(@Param('id') id: string) {
    await this.registry.delete(id);
    return { deleted: true };
  }

  @Put(':id/roles')
  @ApiOperation({ summary: 'Set which agent roles can use this MCP server' })
  async setRoleAssignments(
    @Param('id') id: string,
    @Body() dto: SetRoleAssignmentsDto,
  ) {
    await this.registry.setRoleAssignments(id, dto.roles);
    return this.registry.findOne(id);
  }
}

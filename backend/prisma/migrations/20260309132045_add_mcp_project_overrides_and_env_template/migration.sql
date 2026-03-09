-- CreateEnum
CREATE TYPE "McpOverrideAction" AS ENUM ('ENABLE', 'DISABLE');

-- AlterTable
ALTER TABLE "mcp_server_definitions" ADD COLUMN     "envTemplate" JSONB;

-- CreateTable
CREATE TABLE "mcp_server_project_overrides" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "agentRole" "AgentRole" NOT NULL,
    "action" "McpOverrideAction" NOT NULL,

    CONSTRAINT "mcp_server_project_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_project_overrides_projectId_mcpServerId_agentRol_key" ON "mcp_server_project_overrides"("projectId", "mcpServerId", "agentRole");

-- AddForeignKey
ALTER TABLE "mcp_server_project_overrides" ADD CONSTRAINT "mcp_server_project_overrides_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_project_overrides" ADD CONSTRAINT "mcp_server_project_overrides_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_server_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

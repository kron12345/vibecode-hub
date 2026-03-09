-- CreateTable
CREATE TABLE "mcp_server_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'custom',
    "command" TEXT NOT NULL,
    "args" TEXT[],
    "env" JSONB,
    "argTemplate" TEXT,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_server_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_on_role" (
    "id" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "agentRole" "AgentRole" NOT NULL,

    CONSTRAINT "mcp_server_on_role_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_definitions_name_key" ON "mcp_server_definitions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_on_role_mcpServerId_agentRole_key" ON "mcp_server_on_role"("mcpServerId", "agentRole");

-- AddForeignKey
ALTER TABLE "mcp_server_on_role" ADD CONSTRAINT "mcp_server_on_role_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_server_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum: AgentRole — add new roles
ALTER TYPE "AgentRole" ADD VALUE 'INTERVIEWER';
ALTER TYPE "AgentRole" ADD VALUE 'ARCHITECT';
ALTER TYPE "AgentRole" ADD VALUE 'ISSUE_COMPILER';
ALTER TYPE "AgentRole" ADD VALUE 'FUNCTIONAL_TESTER';
ALTER TYPE "AgentRole" ADD VALUE 'DEVOPS';

-- AlterEnum: AgentRole — remove TICKET_CREATOR (no data uses it)
-- Note: PostgreSQL cannot remove enum values directly, so we recreate
-- Since agent_instances table is empty, this is safe.
ALTER TYPE "AgentRole" RENAME TO "AgentRole_old";
CREATE TYPE "AgentRole" AS ENUM ('INTERVIEWER', 'ARCHITECT', 'ISSUE_COMPILER', 'CODER', 'CODE_REVIEWER', 'UI_TESTER', 'FUNCTIONAL_TESTER', 'PEN_TESTER', 'DOCUMENTER', 'DEVOPS');
ALTER TABLE "agent_instances" ALTER COLUMN "role" TYPE "AgentRole" USING "role"::text::"AgentRole";
DROP TYPE "AgentRole_old";

-- AlterEnum: LLMProvider — add CLI providers and reorder
ALTER TYPE "LLMProvider" RENAME TO "LLMProvider_old";
CREATE TYPE "LLMProvider" AS ENUM ('OLLAMA', 'CLAUDE_CODE', 'CODEX_CLI', 'QWEN3_CODER', 'ANTHROPIC', 'OPENAI', 'GOOGLE');
ALTER TABLE "agent_instances" ALTER COLUMN "provider" TYPE "LLMProvider" USING "provider"::text::"LLMProvider";
DROP TYPE "LLMProvider_old";

-- AlterEnum: AgentTaskType — add new task types
ALTER TYPE "AgentTaskType" ADD VALUE 'INTERVIEW';
ALTER TYPE "AgentTaskType" ADD VALUE 'DESIGN_ARCHITECTURE';
ALTER TYPE "AgentTaskType" ADD VALUE 'TEST_FUNCTIONAL';
ALTER TYPE "AgentTaskType" ADD VALUE 'DEPLOY';

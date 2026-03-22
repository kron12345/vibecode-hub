-- Add MessageVisibility enum
CREATE TYPE "MessageVisibility" AS ENUM ('USER_FACING', 'AGENT_INTERNAL');

-- Add visibility column to chat_messages
ALTER TABLE "chat_messages" ADD COLUMN "visibility" "MessageVisibility" NOT NULL DEFAULT 'USER_FACING';

-- Add WAITING_FOR_INPUT to AgentTaskStatus enum
ALTER TYPE "AgentTaskStatus" ADD VALUE 'WAITING_FOR_INPUT';

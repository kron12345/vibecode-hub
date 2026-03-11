-- CreateEnum
CREATE TYPE "ChatSessionType" AS ENUM ('INFRASTRUCTURE', 'DEV_SESSION');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'MERGING', 'ARCHIVED', 'CONFLICT');

-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "type" "ChatSessionType" NOT NULL DEFAULT 'INFRASTRUCTURE';

-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "chatSessionId" TEXT;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

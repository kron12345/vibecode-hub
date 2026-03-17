-- CreateTable
CREATE TABLE "finding_threads" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "mrIid" INTEGER NOT NULL,
    "agentRole" "AgentRole" NOT NULL,
    "discussionId" TEXT NOT NULL,
    "rootNoteId" INTEGER NOT NULL,
    "threadUrl" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "roundNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finding_threads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finding_threads_issueId_mrIid_resolved_idx" ON "finding_threads"("issueId", "mrIid", "resolved");

-- CreateIndex
CREATE INDEX "finding_threads_discussionId_idx" ON "finding_threads"("discussionId");

-- AddForeignKey
ALTER TABLE "finding_threads" ADD CONSTRAINT "finding_threads_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

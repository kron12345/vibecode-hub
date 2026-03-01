-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('INTERVIEWING', 'SETTING_UP', 'READY', 'ARCHIVED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "status" "ProjectStatus" NOT NULL DEFAULT 'READY',
ADD COLUMN     "techStack" JSONB;

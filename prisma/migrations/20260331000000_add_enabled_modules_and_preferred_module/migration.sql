-- AlterTable: Add enabledModules to companies
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "enabled_modules" TEXT[] DEFAULT ARRAY['logistics']::TEXT[];

-- AlterTable: Add preferredModule to user_companies
ALTER TABLE "user_companies" ADD COLUMN IF NOT EXISTS "preferred_module" VARCHAR(20);

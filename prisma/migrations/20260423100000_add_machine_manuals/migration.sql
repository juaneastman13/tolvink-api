-- CreateTable
CREATE TABLE "machine_manuals" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "keywords" TEXT,
    "file_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_manuals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "machine_manuals_company_id_idx" ON "machine_manuals"("company_id");

-- CreateIndex
CREATE INDEX "machine_manuals_machine_id_idx" ON "machine_manuals"("machine_id");

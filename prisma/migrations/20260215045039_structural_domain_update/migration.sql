-- CreateEnum
CREATE TYPE "DocumentStep" AS ENUM ('request', 'assignment', 'load_confirmation', 'delivery_confirmation', 'cancellation');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'conversation_started';

-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "freight_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "freight_assignments" ADD COLUMN     "truck_id" TEXT;

-- AlterTable
ALTER TABLE "freight_documents" ADD COLUMN     "step" "DocumentStep";

-- AlterTable
ALTER TABLE "freights" ADD COLUMN     "scheduled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "lots" ADD COLUMN     "field_id" TEXT,
ALTER COLUMN "lat" DROP NOT NULL,
ALTER COLUMN "lng" DROP NOT NULL;

-- CreateTable
CREATE TABLE "fields" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "company_id" TEXT NOT NULL,
    "address" TEXT,
    "lat" DECIMAL(10,6),
    "lng" DECIMAL(10,6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trucks" (
    "id" TEXT NOT NULL,
    "plate" VARCHAR(20) NOT NULL,
    "model" VARCHAR(100),
    "company_id" TEXT NOT NULL,
    "assigned_user_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trucks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_producer_access" (
    "id" TEXT NOT NULL,
    "plant_company_id" TEXT NOT NULL,
    "producer_company_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plant_producer_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fields_company_id_idx" ON "fields"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "trucks_plate_key" ON "trucks"("plate");

-- CreateIndex
CREATE INDEX "trucks_company_id_idx" ON "trucks"("company_id");

-- CreateIndex
CREATE INDEX "trucks_plate_idx" ON "trucks"("plate");

-- CreateIndex
CREATE INDEX "plant_producer_access_plant_company_id_idx" ON "plant_producer_access"("plant_company_id");

-- CreateIndex
CREATE INDEX "plant_producer_access_producer_company_id_idx" ON "plant_producer_access"("producer_company_id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_producer_access_plant_company_id_producer_company_id_key" ON "plant_producer_access"("plant_company_id", "producer_company_id");

-- CreateIndex
CREATE INDEX "conversation_participants_company_id_idx" ON "conversation_participants"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_conversation_id_company_id_key" ON "conversation_participants"("conversation_id", "company_id");

-- CreateIndex
CREATE INDEX "freight_assignments_truck_id_idx" ON "freight_assignments"("truck_id");

-- CreateIndex
CREATE INDEX "freight_documents_freight_id_step_idx" ON "freight_documents"("freight_id", "step");

-- CreateIndex
CREATE INDEX "lots_field_id_idx" ON "lots"("field_id");

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_producer_access" ADD CONSTRAINT "plant_producer_access_plant_company_id_fkey" FOREIGN KEY ("plant_company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_producer_access" ADD CONSTRAINT "plant_producer_access_producer_company_id_fkey" FOREIGN KEY ("producer_company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_assignments" ADD CONSTRAINT "freight_assignments_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

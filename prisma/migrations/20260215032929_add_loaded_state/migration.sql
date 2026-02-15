-- AlterEnum
ALTER TYPE "FreightStatus" ADD VALUE 'loaded';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'freight_loaded';
ALTER TYPE "NotificationType" ADD VALUE 'freight_confirmed';

-- AlterTable
ALTER TABLE "freights" ADD COLUMN     "loaded_at" TIMESTAMP(3),
ADD COLUMN     "plant_finished_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "producer_loaded_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "transporter_finished_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "transporter_loaded_confirmed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "shared_fields" (
    "id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "shared_by_user_id" TEXT NOT NULL,
    "shared_with_user_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_lots" (
    "id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "shared_by_user_id" TEXT NOT NULL,
    "shared_with_user_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shared_fields_shared_with_user_id_idx" ON "shared_fields"("shared_with_user_id");

-- CreateIndex
CREATE INDEX "shared_fields_field_id_idx" ON "shared_fields"("field_id");

-- CreateIndex
CREATE UNIQUE INDEX "shared_fields_field_id_shared_with_user_id_key" ON "shared_fields"("field_id", "shared_with_user_id");

-- CreateIndex
CREATE INDEX "shared_lots_shared_with_user_id_idx" ON "shared_lots"("shared_with_user_id");

-- CreateIndex
CREATE INDEX "shared_lots_lot_id_idx" ON "shared_lots"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "shared_lots_lot_id_shared_with_user_id_key" ON "shared_lots"("lot_id", "shared_with_user_id");

-- AddForeignKey
ALTER TABLE "shared_fields" ADD CONSTRAINT "shared_fields_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_fields" ADD CONSTRAINT "shared_fields_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_fields" ADD CONSTRAINT "shared_fields_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_lots" ADD CONSTRAINT "shared_lots_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_lots" ADD CONSTRAINT "shared_lots_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_lots" ADD CONSTRAINT "shared_lots_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

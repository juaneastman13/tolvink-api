-- CreateTable
CREATE TABLE "weigh_tickets" (
    "id" TEXT NOT NULL,
    "freight_id" TEXT NOT NULL,
    "assignment_id" TEXT,
    "type" VARCHAR(20) NOT NULL DEFAULT 'destination',
    "ticket_number" VARCHAR(100),
    "gross_weight" DECIMAL(10,2),
    "tare_weight" DECIMAL(10,2),
    "net_weight" DECIMAL(10,2),
    "humidity" DECIMAL(5,2),
    "impurities" DECIMAL(5,2),
    "dockage" DECIMAL(10,2),
    "temperature" DECIMAL(5,2),
    "observations" TEXT,
    "photo_url" VARCHAR(500),
    "ocr_data" JSONB,
    "ocr_confidence" DECIMAL(3,2),
    "registered_by_id" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weigh_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weigh_tickets_freight_id_idx" ON "weigh_tickets"("freight_id");

-- CreateIndex
CREATE INDEX "weigh_tickets_assignment_id_idx" ON "weigh_tickets"("assignment_id");

-- CreateIndex
CREATE INDEX "weigh_tickets_ticket_number_idx" ON "weigh_tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "weigh_tickets_freight_id_assignment_id_type_idx" ON "weigh_tickets"("freight_id", "assignment_id", "type");

-- AddForeignKey
ALTER TABLE "weigh_tickets" ADD CONSTRAINT "weigh_tickets_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weigh_tickets" ADD CONSTRAINT "weigh_tickets_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "freight_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weigh_tickets" ADD CONSTRAINT "weigh_tickets_registered_by_id_fkey" FOREIGN KEY ("registered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

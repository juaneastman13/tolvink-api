-- CreateTable
CREATE TABLE "agro_pres_fisico" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "ejercicio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "centro" "AgroCentroTipo",
    "categoria_cod" VARCHAR(20),
    "producto_id" TEXT,
    "lote_campania_id" TEXT,
    "concepto" VARCHAR(50) NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "unidad" "AgroUnidad",
    "obs" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_pres_fisico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_pres_precio" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "ejercicio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "escenario" "AgroEscenario" NOT NULL,
    "producto_id" TEXT,
    "categoria_cod" VARCHAR(20),
    "precio_usd" DECIMAL(12,4) NOT NULL,
    "unidad" "AgroUnidad",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_pres_precio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agro_pres_fisico_empresa_id_ejercicio_mes_idx" ON "agro_pres_fisico"("empresa_id", "ejercicio", "mes");

-- CreateIndex
CREATE INDEX "agro_pres_fisico_empresa_id_ejercicio_concepto_idx" ON "agro_pres_fisico"("empresa_id", "ejercicio", "concepto");

-- CreateIndex
CREATE INDEX "agro_pres_precio_empresa_id_ejercicio_escenario_idx" ON "agro_pres_precio"("empresa_id", "ejercicio", "escenario");

-- CreateIndex
CREATE UNIQUE INDEX "agro_pres_precio_empresa_id_ejercicio_mes_escenario_product_key" ON "agro_pres_precio"("empresa_id", "ejercicio", "mes", "escenario", "producto_id", "categoria_cod");

-- AddForeignKey
ALTER TABLE "agro_pres_fisico" ADD CONSTRAINT "agro_pres_fisico_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_pres_fisico" ADD CONSTRAINT "agro_pres_fisico_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "agro_producto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_pres_fisico" ADD CONSTRAINT "agro_pres_fisico_lote_campania_id_fkey" FOREIGN KEY ("lote_campania_id") REFERENCES "agro_lote_campania"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_pres_precio" ADD CONSTRAINT "agro_pres_precio_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_pres_precio" ADD CONSTRAINT "agro_pres_precio_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "agro_producto"("id") ON DELETE CASCADE ON UPDATE CASCADE;


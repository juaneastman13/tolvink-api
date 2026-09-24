-- CreateEnum
CREATE TYPE "AgroModoMaquinaria" AS ENUM ('PORCENTAJE', 'TARIFA');

-- CreateEnum
CREATE TYPE "AgroEscenario" AS ENUM ('PESIMISTA', 'BASE', 'OPTIMISTA');

-- CreateEnum
CREATE TYPE "AgroCentroTipo" AS ENUM ('CRI', 'REC', 'FEED', 'AGR', 'MAQ', 'PAS', 'EST');

-- CreateEnum
CREATE TYPE "AgroTipoLoteCampania" AS ENUM ('SOJA1', 'SOJA2', 'TRIGO');

-- CreateEnum
CREATE TYPE "AgroTipoTercero" AS ENUM ('PROVEEDOR', 'CLIENTE', 'FRIGORIFICO', 'CONTRATISTA', 'BANCO', 'OTRO');

-- CreateEnum
CREATE TYPE "AgroTipoProducto" AS ENUM ('SEMILLA', 'FERTILIZANTE', 'AGROQUIMICO', 'RACION', 'GRANO_COMERCIAL', 'COMBUSTIBLE', 'SANIDAD', 'OTRO');

-- CreateEnum
CREATE TYPE "AgroUnidad" AS ENUM ('KG', 'TON', 'LT', 'UN', 'HA', 'DOSIS', 'BOLSA');

-- CreateEnum
CREATE TYPE "AgroCuentaTipo" AS ENUM ('INGRESO', 'COSTO_DIRECTO', 'COSTO_INDIRECTO', 'ESTRUCTURA', 'FINANCIERO', 'IMPUESTO');

-- CreateEnum
CREATE TYPE "AgroMovHaciendaTipo" AS ENUM ('NACIMIENTO', 'COMPRA', 'VENTA', 'MUERTE', 'TRANSF', 'RECATEG', 'PESADA', 'INVENTARIO', 'DICOSE', 'TACTO');

-- CreateEnum
CREATE TYPE "AgroMovGranoTipo" AS ENUM ('COSECHA', 'VENTA', 'FEEDLOT');

-- CreateEnum
CREATE TYPE "AgroMovOrigen" AS ENUM ('WEB', 'WHATSAPP', 'IMPORT');

-- CreateEnum
CREATE TYPE "AgroPrestamoMoneda" AS ENUM ('USD', 'UYU');

-- CreateTable
CREATE TABLE "agro_empresa" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "nombre" VARCHAR(255) NOT NULL,
    "rut" VARCHAR(20),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_empresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_config" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "mes_inicio_ejercicio" INTEGER NOT NULL DEFAULT 1,
    "cierre_intermedio_mes" INTEGER,
    "cierre_intermedio_dia" INTEGER,
    "tasa_costo_oportunidad" DECIMAL(6,4) NOT NULL DEFAULT 0.05,
    "modo_maquinaria" "AgroModoMaquinaria" NOT NULL DEFAULT 'PORCENTAJE',
    "escenario_activo" "AgroEscenario" NOT NULL DEFAULT 'BASE',
    "pas_habilitado" BOOLEAN NOT NULL DEFAULT false,
    "p_base_carne" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "p_base_soja" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "p_base_trigo" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "desvio_usd" DECIMAL(14,2) NOT NULL DEFAULT 1000,
    "desvio_pct" DECIMAL(5,4) NOT NULL DEFAULT 0.1,
    "saldo_minimo_operativo" DECIMAL(14,2) NOT NULL DEFAULT 15000,
    "porcentajes_asignacion" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_centro" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "codigo" "AgroCentroTipo" NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_centro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_categoria_animal" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "codigo" VARCHAR(20) NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "equivalencia_ug" DECIMAL(6,3) NOT NULL,
    "centro_habitual" "AgroCentroTipo",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_categoria_animal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_cuenta" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "codigo" VARCHAR(20) NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "tipo" "AgroCuentaTipo" NOT NULL,
    "centro_default" "AgroCentroTipo",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_cuenta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_tercero" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "tipo" "AgroTipoTercero" NOT NULL,
    "rut" VARCHAR(20),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_tercero_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_producto" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "codigo" VARCHAR(30) NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "tipo" "AgroTipoProducto" NOT NULL,
    "unidad" "AgroUnidad" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_campo" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "hectareas" DECIMAL(10,2) NOT NULL,
    "propio" BOOLEAN NOT NULL DEFAULT true,
    "renta_usd_ha_ano" DECIMAL(10,2),
    "aptitud" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_campo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_potrero" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "campo_id" TEXT NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "hectareas" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_potrero_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_lote_campania" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "potrero_id" TEXT,
    "campania" VARCHAR(20) NOT NULL,
    "tipo" "AgroTipoLoteCampania" NOT NULL,
    "hectareas" DECIMAL(10,2) NOT NULL,
    "fecha_siembra" DATE,
    "fecha_cosecha" DATE,
    "rinde_esperado" DECIMAL(8,2),
    "cerrado" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_lote_campania_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_tanda" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "codigo" VARCHAR(30) NOT NULL,
    "fecha_ingreso" DATE NOT NULL,
    "corral" VARCHAR(50),
    "categoria_cod" VARCHAR(20),
    "fecha_cierre" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_tanda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_prestamo" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "capital" DECIMAL(14,2) NOT NULL,
    "moneda" "AgroPrestamoMoneda" NOT NULL,
    "tasa_anual" DECIMAL(6,4) NOT NULL,
    "cuotas" INTEGER NOT NULL,
    "garantia" VARCHAR(200),
    "fecha_inicio" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agro_prestamo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_tipo_cambio" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "uyu_usd" DECIMAL(10,4) NOT NULL,
    "fuente" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agro_tipo_cambio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_mov_hacienda" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "tipo" "AgroMovHaciendaTipo" NOT NULL,
    "centro" "AgroCentroTipo" NOT NULL,
    "categoria_cod" VARCHAR(20) NOT NULL,
    "centro_destino" "AgroCentroTipo",
    "categoria_destino" VARCHAR(20),
    "tanda_id" TEXT,
    "cabezas" INTEGER NOT NULL,
    "kg_cab" DECIMAL(8,2),
    "kg_total" DECIMAL(12,2),
    "usd_kg" DECIMAL(10,4),
    "prenadas" INTEGER,
    "tercero_id" TEXT,
    "guia" VARCHAR(50),
    "obs" TEXT,
    "fecha_cobro_pago" DATE,
    "origen" "AgroMovOrigen" NOT NULL DEFAULT 'WEB',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anulado_at" TIMESTAMP(3),
    "anulado_por" TEXT,
    "motivo_anulacion" TEXT,

    CONSTRAINT "agro_mov_hacienda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_mov_grano" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "tipo" "AgroMovGranoTipo" NOT NULL,
    "lote_campania_id" TEXT,
    "producto_id" TEXT NOT NULL,
    "toneladas" DECIMAL(12,3) NOT NULL,
    "precio_neto_usd_t" DECIMAL(12,4),
    "fecha_cobro" DATE,
    "tanda_id" TEXT,
    "obs" TEXT,
    "origen" "AgroMovOrigen" NOT NULL DEFAULT 'WEB',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anulado_at" TIMESTAMP(3),
    "anulado_por" TEXT,
    "motivo_anulacion" TEXT,

    CONSTRAINT "agro_mov_grano_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_gasto" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "tercero_id" TEXT,
    "cuenta_id" TEXT NOT NULL,
    "centro" "AgroCentroTipo" NOT NULL,
    "lote_campania_id" TEXT,
    "tanda_id" TEXT,
    "prestamo_id" TEXT,
    "detalle" TEXT,
    "moneda" VARCHAR(3) NOT NULL,
    "monto" DECIMAL(14,2) NOT NULL,
    "tipo_cambio" DECIMAL(10,4) NOT NULL,
    "monto_usd" DECIMAL(14,2) NOT NULL,
    "comprobante" VARCHAR(100),
    "fecha_pago" DATE,
    "cantidad" DECIMAL(14,3),
    "unidad" "AgroUnidad",
    "origen" "AgroMovOrigen" NOT NULL DEFAULT 'WEB',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anulado_at" TIMESTAMP(3),
    "anulado_por" TEXT,
    "motivo_anulacion" TEXT,

    CONSTRAINT "agro_gasto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_labor" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "lote_campania_id" TEXT NOT NULL,
    "tipo_labor" VARCHAR(100) NOT NULL,
    "hectareas" DECIMAL(10,2) NOT NULL,
    "propia" BOOLEAN NOT NULL DEFAULT true,
    "tarifa_usd_ha" DECIMAL(10,2),
    "obs" TEXT,
    "origen" "AgroMovOrigen" NOT NULL DEFAULT 'WEB',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anulado_at" TIMESTAMP(3),

    CONSTRAINT "agro_labor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_lluvia" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "mm" DECIMAL(6,2) NOT NULL,
    "pluviometro" VARCHAR(100),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agro_lluvia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_precio" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "producto_id" TEXT,
    "categoria_cod" VARCHAR(20),
    "centro" "AgroCentroTipo",
    "precio_usd" DECIMAL(12,4) NOT NULL,
    "concepto" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agro_precio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agro_captura_pendiente" (
    "id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,
    "phone" VARCHAR(50) NOT NULL,
    "message_id" VARCHAR(120),
    "mensaje_crudo" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "dudas" JSONB NOT NULL DEFAULT '[]',
    "observaciones" JSONB NOT NULL DEFAULT '[]',
    "estado" VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    "confirmado_by" TEXT,
    "confirmado_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_at" TIMESTAMP(3),

    CONSTRAINT "agro_captura_pendiente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agro_empresa_company_id_active_idx" ON "agro_empresa"("company_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "agro_config_empresa_id_key" ON "agro_config"("empresa_id");

-- CreateIndex
CREATE UNIQUE INDEX "agro_centro_empresa_id_codigo_key" ON "agro_centro"("empresa_id", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "agro_categoria_animal_empresa_id_codigo_key" ON "agro_categoria_animal"("empresa_id", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "agro_cuenta_empresa_id_codigo_key" ON "agro_cuenta"("empresa_id", "codigo");

-- CreateIndex
CREATE INDEX "agro_tercero_empresa_id_tipo_idx" ON "agro_tercero"("empresa_id", "tipo");

-- CreateIndex
CREATE UNIQUE INDEX "agro_producto_empresa_id_codigo_key" ON "agro_producto"("empresa_id", "codigo");

-- CreateIndex
CREATE INDEX "agro_potrero_campo_id_idx" ON "agro_potrero"("campo_id");

-- CreateIndex
CREATE INDEX "agro_lote_campania_empresa_id_campania_idx" ON "agro_lote_campania"("empresa_id", "campania");

-- CreateIndex
CREATE UNIQUE INDEX "agro_tanda_empresa_id_codigo_key" ON "agro_tanda"("empresa_id", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "agro_tipo_cambio_empresa_id_fecha_key" ON "agro_tipo_cambio"("empresa_id", "fecha");

-- CreateIndex
CREATE INDEX "agro_mov_hacienda_empresa_id_fecha_idx" ON "agro_mov_hacienda"("empresa_id", "fecha");

-- CreateIndex
CREATE INDEX "agro_mov_hacienda_empresa_id_centro_categoria_cod_idx" ON "agro_mov_hacienda"("empresa_id", "centro", "categoria_cod");

-- CreateIndex
CREATE INDEX "agro_mov_hacienda_empresa_id_tanda_id_idx" ON "agro_mov_hacienda"("empresa_id", "tanda_id");

-- CreateIndex
CREATE INDEX "agro_mov_grano_empresa_id_fecha_idx" ON "agro_mov_grano"("empresa_id", "fecha");

-- CreateIndex
CREATE INDEX "agro_mov_grano_empresa_id_lote_campania_id_idx" ON "agro_mov_grano"("empresa_id", "lote_campania_id");

-- CreateIndex
CREATE INDEX "agro_mov_grano_empresa_id_tanda_id_idx" ON "agro_mov_grano"("empresa_id", "tanda_id");

-- CreateIndex
CREATE INDEX "agro_gasto_empresa_id_fecha_idx" ON "agro_gasto"("empresa_id", "fecha");

-- CreateIndex
CREATE INDEX "agro_gasto_empresa_id_centro_idx" ON "agro_gasto"("empresa_id", "centro");

-- CreateIndex
CREATE INDEX "agro_gasto_empresa_id_cuenta_id_idx" ON "agro_gasto"("empresa_id", "cuenta_id");

-- CreateIndex
CREATE INDEX "agro_labor_empresa_id_fecha_idx" ON "agro_labor"("empresa_id", "fecha");

-- CreateIndex
CREATE INDEX "agro_labor_lote_campania_id_idx" ON "agro_labor"("lote_campania_id");

-- CreateIndex
CREATE INDEX "agro_lluvia_empresa_id_fecha_idx" ON "agro_lluvia"("empresa_id", "fecha");

-- CreateIndex
CREATE INDEX "agro_precio_empresa_id_fecha_idx" ON "agro_precio"("empresa_id", "fecha");

-- CreateIndex
CREATE INDEX "agro_precio_empresa_id_producto_id_fecha_idx" ON "agro_precio"("empresa_id", "producto_id", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "agro_captura_pendiente_message_id_key" ON "agro_captura_pendiente"("message_id");

-- CreateIndex
CREATE INDEX "agro_captura_pendiente_empresa_id_estado_idx" ON "agro_captura_pendiente"("empresa_id", "estado");

-- CreateIndex
CREATE INDEX "agro_captura_pendiente_phone_created_at_idx" ON "agro_captura_pendiente"("phone", "created_at");

-- AddForeignKey
ALTER TABLE "agro_config" ADD CONSTRAINT "agro_config_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_centro" ADD CONSTRAINT "agro_centro_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_categoria_animal" ADD CONSTRAINT "agro_categoria_animal_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_cuenta" ADD CONSTRAINT "agro_cuenta_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_tercero" ADD CONSTRAINT "agro_tercero_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_producto" ADD CONSTRAINT "agro_producto_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_campo" ADD CONSTRAINT "agro_campo_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_potrero" ADD CONSTRAINT "agro_potrero_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_potrero" ADD CONSTRAINT "agro_potrero_campo_id_fkey" FOREIGN KEY ("campo_id") REFERENCES "agro_campo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_lote_campania" ADD CONSTRAINT "agro_lote_campania_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_lote_campania" ADD CONSTRAINT "agro_lote_campania_potrero_id_fkey" FOREIGN KEY ("potrero_id") REFERENCES "agro_potrero"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_tanda" ADD CONSTRAINT "agro_tanda_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_prestamo" ADD CONSTRAINT "agro_prestamo_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_tipo_cambio" ADD CONSTRAINT "agro_tipo_cambio_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_mov_hacienda" ADD CONSTRAINT "agro_mov_hacienda_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_mov_hacienda" ADD CONSTRAINT "agro_mov_hacienda_tanda_id_fkey" FOREIGN KEY ("tanda_id") REFERENCES "agro_tanda"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_mov_hacienda" ADD CONSTRAINT "agro_mov_hacienda_tercero_id_fkey" FOREIGN KEY ("tercero_id") REFERENCES "agro_tercero"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_mov_grano" ADD CONSTRAINT "agro_mov_grano_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_mov_grano" ADD CONSTRAINT "agro_mov_grano_lote_campania_id_fkey" FOREIGN KEY ("lote_campania_id") REFERENCES "agro_lote_campania"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_mov_grano" ADD CONSTRAINT "agro_mov_grano_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "agro_producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_mov_grano" ADD CONSTRAINT "agro_mov_grano_tanda_id_fkey" FOREIGN KEY ("tanda_id") REFERENCES "agro_tanda"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_gasto" ADD CONSTRAINT "agro_gasto_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_gasto" ADD CONSTRAINT "agro_gasto_tercero_id_fkey" FOREIGN KEY ("tercero_id") REFERENCES "agro_tercero"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_gasto" ADD CONSTRAINT "agro_gasto_cuenta_id_fkey" FOREIGN KEY ("cuenta_id") REFERENCES "agro_cuenta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_gasto" ADD CONSTRAINT "agro_gasto_lote_campania_id_fkey" FOREIGN KEY ("lote_campania_id") REFERENCES "agro_lote_campania"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_gasto" ADD CONSTRAINT "agro_gasto_tanda_id_fkey" FOREIGN KEY ("tanda_id") REFERENCES "agro_tanda"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_labor" ADD CONSTRAINT "agro_labor_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_labor" ADD CONSTRAINT "agro_labor_lote_campania_id_fkey" FOREIGN KEY ("lote_campania_id") REFERENCES "agro_lote_campania"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_lluvia" ADD CONSTRAINT "agro_lluvia_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_precio" ADD CONSTRAINT "agro_precio_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_precio" ADD CONSTRAINT "agro_precio_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "agro_producto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agro_captura_pendiente" ADD CONSTRAINT "agro_captura_pendiente_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "agro_empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;


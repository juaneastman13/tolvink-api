import { Injectable } from '@nestjs/common';
import {
  AgroCentroTipo,
  AgroCuentaTipo,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Seeds base para una AgroEmpresa recién creada.
 *
 * Idempotente: usa `upsert` por `(empresa_id, codigo)`. Se puede volver a
 * ejecutar sin duplicar datos.
 *
 * También hay un script CLI equivalente en `prisma/seed-agro.ts` para
 * aplicarlo standalone: `npx ts-node prisma/seed-agro.ts <empresaId>`.
 */

// Centros base — PAS queda inactivo por defecto y se activa desde AgroConfig.pasHabilitado.
const CENTROS: Array<{ codigo: AgroCentroTipo; nombre: string; active?: boolean }> = [
  { codigo: 'CRI', nombre: 'Cría' },
  { codigo: 'REC', nombre: 'Recría' },
  { codigo: 'FEED', nombre: 'Feedlot' },
  { codigo: 'AGR', nombre: 'Agricultura' },
  { codigo: 'MAQ', nombre: 'Maquinaria' },
  { codigo: 'PAS', nombre: 'Pasturas compartidas', active: false },
  { codigo: 'EST', nombre: 'Estructura / no asignado' },
];

// UG estándar UY (referencia INIA/Plan Agropecuario). [VERIFICAR con la tabla oficial que use la empresa]
const CATEGORIAS: Array<{
  codigo: string;
  nombre: string;
  equivalenciaUg: number;
  centroHabitual?: AgroCentroTipo;
}> = [
  { codigo: 'VC', nombre: 'Vaca de cría', equivalenciaUg: 1.0, centroHabitual: 'CRI' },
  { codigo: 'VE', nombre: 'Vaca de invernada', equivalenciaUg: 1.0, centroHabitual: 'REC' },
  { codigo: 'TORO', nombre: 'Toro', equivalenciaUg: 1.3, centroHabitual: 'CRI' },
  { codigo: 'VQ', nombre: 'Vaquillona 2-3 años', equivalenciaUg: 0.75, centroHabitual: 'REC' },
  { codigo: 'VQ12', nombre: 'Vaquillona 1-2 años', equivalenciaUg: 0.6, centroHabitual: 'REC' },
  { codigo: 'NM', nombre: 'Novillo mayor (>3 años)', equivalenciaUg: 1.0, centroHabitual: 'REC' },
  { codigo: 'N23', nombre: 'Novillo 2-3 años', equivalenciaUg: 0.85, centroHabitual: 'REC' },
  { codigo: 'N12', nombre: 'Novillo 1-2 años', equivalenciaUg: 0.65, centroHabitual: 'REC' },
  { codigo: 'TH', nombre: 'Ternero/a hembra al pie', equivalenciaUg: 0.4, centroHabitual: 'CRI' },
  { codigo: 'TM', nombre: 'Ternero/a macho al pie', equivalenciaUg: 0.4, centroHabitual: 'CRI' },
  { codigo: 'FEED', nombre: 'Encierre (feedlot, s/categoría)', equivalenciaUg: 0.85, centroHabitual: 'FEED' },
];

const CUENTAS: Array<{
  codigo: string;
  nombre: string;
  tipo: AgroCuentaTipo;
  centroDefault?: AgroCentroTipo;
}> = [
  { codigo: 'ING_HAC', nombre: 'Venta de hacienda', tipo: 'INGRESO' },
  { codigo: 'ING_GRA', nombre: 'Venta de granos', tipo: 'INGRESO', centroDefault: 'AGR' },
  { codigo: 'ING_TRINT', nombre: 'Transferencia interna grano→feedlot', tipo: 'INGRESO', centroDefault: 'AGR' },
  { codigo: 'CD_SEMI', nombre: 'Semillas', tipo: 'COSTO_DIRECTO', centroDefault: 'AGR' },
  { codigo: 'CD_FERT', nombre: 'Fertilizantes', tipo: 'COSTO_DIRECTO', centroDefault: 'AGR' },
  { codigo: 'CD_AGROQ', nombre: 'Agroquímicos', tipo: 'COSTO_DIRECTO', centroDefault: 'AGR' },
  { codigo: 'CD_LABOR', nombre: 'Labores agrícolas', tipo: 'COSTO_DIRECTO', centroDefault: 'AGR' },
  { codigo: 'CD_COSECHA', nombre: 'Cosecha', tipo: 'COSTO_DIRECTO', centroDefault: 'AGR' },
  { codigo: 'CD_FLETE', nombre: 'Fletes', tipo: 'COSTO_DIRECTO' },
  { codigo: 'CD_SANIDAD', nombre: 'Sanidad animal', tipo: 'COSTO_DIRECTO' },
  { codigo: 'CD_SUPL', nombre: 'Suplementación (ración/grano)', tipo: 'COSTO_DIRECTO', centroDefault: 'FEED' },
  { codigo: 'CD_TRINT', nombre: 'Costo transferencia interna grano→feedlot', tipo: 'COSTO_DIRECTO', centroDefault: 'FEED' },
  { codigo: 'CI_PERS', nombre: 'Personal', tipo: 'COSTO_INDIRECTO' },
  { codigo: 'CI_MAQ', nombre: 'Maquinaria (combustible, mantenimiento)', tipo: 'COSTO_INDIRECTO', centroDefault: 'MAQ' },
  { codigo: 'CI_RENTA', nombre: 'Renta de tierra (ficta/real)', tipo: 'COSTO_INDIRECTO' },
  { codigo: 'ES_ADMIN', nombre: 'Administración', tipo: 'ESTRUCTURA', centroDefault: 'EST' },
  { codigo: 'ES_IMP', nombre: 'Impuestos y tasas', tipo: 'ESTRUCTURA', centroDefault: 'EST' },
  { codigo: 'ES_ASESOR', nombre: 'Asesoramiento', tipo: 'ESTRUCTURA', centroDefault: 'EST' },
  { codigo: 'FN_INT', nombre: 'Intereses', tipo: 'FINANCIERO' },
  { codigo: 'FN_DIF', nombre: 'Diferencia de cambio', tipo: 'FINANCIERO' },
];

@Injectable()
export class AgroSeedService {
  constructor(private prisma: PrismaService) {}

  async seedEmpresa(empresaId: string): Promise<void> {
    for (const c of CENTROS) {
      await this.prisma.agroCentro.upsert({
        where: { empresaId_codigo: { empresaId, codigo: c.codigo } },
        create: { empresaId, codigo: c.codigo, nombre: c.nombre, active: c.active ?? true },
        update: { nombre: c.nombre },
      });
    }
    for (const cat of CATEGORIAS) {
      await this.prisma.agroCategoriaAnimal.upsert({
        where: { empresaId_codigo: { empresaId, codigo: cat.codigo } },
        create: {
          empresaId,
          codigo: cat.codigo,
          nombre: cat.nombre,
          equivalenciaUg: new Prisma.Decimal(cat.equivalenciaUg),
          centroHabitual: cat.centroHabitual ?? null,
        },
        update: {
          nombre: cat.nombre,
          equivalenciaUg: new Prisma.Decimal(cat.equivalenciaUg),
          centroHabitual: cat.centroHabitual ?? null,
        },
      });
    }
    for (const cta of CUENTAS) {
      await this.prisma.agroCuenta.upsert({
        where: { empresaId_codigo: { empresaId, codigo: cta.codigo } },
        create: {
          empresaId,
          codigo: cta.codigo,
          nombre: cta.nombre,
          tipo: cta.tipo,
          centroDefault: cta.centroDefault ?? null,
        },
        update: {
          nombre: cta.nombre,
          tipo: cta.tipo,
          centroDefault: cta.centroDefault ?? null,
        },
      });
    }
    await this.prisma.agroConfig.upsert({
      where: { empresaId },
      create: { empresaId, mesInicioEjercicio: 1, cierreIntermedioMes: 6, cierreIntermedioDia: 30 },
      update: {},
    });
  }
}

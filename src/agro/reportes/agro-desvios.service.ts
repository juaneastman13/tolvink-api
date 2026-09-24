import { Injectable, NotFoundException } from '@nestjs/common';
import { AgroCentroTipo, AgroEscenario } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../database/prisma.service';
import { calcularDesvio, pasaUmbral } from '../dominio/desvio';
import { AgroPresupuestoService } from '../presupuesto/agro-presupuesto.controller';
import {
  ejercicioDe,
  EjercicioConfig,
  rangoDeEjercicio,
} from '../dominio/ejercicio';

/**
 * §6 — Reporte presupuesto vs real, con descomposición precio/cantidad y alerta.
 *
 * Estrategia: agrupamos ambos lados por `(centro, concepto)` y sumamos
 * cantidades y montos. El "precio" implícito de cada grupo se calcula como
 * `monto / cantidad`. La descomposición se aplica sobre esos totales.
 *
 * Cuando el grupo no matchea entre presupuesto y real, se muestra igual
 * con la contraparte en 0.
 */
@Injectable()
export class AgroDesviosService {
  constructor(
    private prisma: PrismaService,
    private presupuesto: AgroPresupuestoService,
  ) {}

  async presupuestoVsReal(
    empresaId: string,
    ejercicio?: number,
    escenario?: AgroEscenario,
  ) {
    const cfg = await this.prisma.agroConfig.findUnique({ where: { empresaId } });
    if (!cfg) throw new NotFoundException('Falta AgroConfig');
    const cfgEj: EjercicioConfig = {
      mesInicioEjercicio: cfg.mesInicioEjercicio,
      cierreIntermedioMes: cfg.cierreIntermedioMes,
      cierreIntermedioDia: cfg.cierreIntermedioDia,
    };
    const ej = ejercicio ?? ejercicioDe(cfgEj, new Date());
    const { desde, hasta } = rangoDeEjercicio(cfgEj, ej);

    // Presupuesto económico del ejercicio bajo el escenario elegido.
    const economico = await this.presupuesto.calcularEconomico(
      empresaId,
      ej,
      escenario,
    );

    // Real: agrupamos por (centro, cuenta) para gastos, y por (centro, "VENTA")
    // para ingresos de hacienda y granos.
    const [gastos, ventasHac, ventasGrano] = await Promise.all([
      this.prisma.agroGasto.findMany({
        where: {
          empresaId,
          fecha: { gte: desde, lte: hasta },
          anuladoAt: null,
        },
        select: {
          centro: true,
          montoUsd: true,
          cantidad: true,
          cuenta: { select: { codigo: true } },
        },
      }),
      this.prisma.agroMovHacienda.findMany({
        where: {
          empresaId,
          fecha: { gte: desde, lte: hasta },
          anuladoAt: null,
          tipo: 'VENTA',
        },
        select: { centro: true, kgTotal: true, usdKg: true },
      }),
      this.prisma.agroMovGrano.findMany({
        where: {
          empresaId,
          fecha: { gte: desde, lte: hasta },
          anuladoAt: null,
          tipo: { in: ['VENTA', 'FEEDLOT'] },
        },
        select: { toneladas: true, precioNetoUsdT: true, tipo: true },
      }),
    ]);

    interface Bucket {
      cantidad: Decimal;
      monto: Decimal;
    }
    const claves = new Set<string>();
    const bucketReal = new Map<string, Bucket>();
    const bucketPres = new Map<string, Bucket>();

    const add = (
      map: Map<string, Bucket>,
      k: string,
      cantidad: Decimal,
      monto: Decimal,
    ) => {
      claves.add(k);
      const prev = map.get(k) ?? { cantidad: new Decimal(0), monto: new Decimal(0) };
      prev.cantidad = prev.cantidad.plus(cantidad);
      prev.monto = prev.monto.plus(monto);
      map.set(k, prev);
    };

    // Real
    for (const g of gastos) {
      const k = `${g.centro}::${g.cuenta.codigo}`;
      add(map1(bucketReal, k), k, new Decimal(g.cantidad ?? 0), new Decimal(g.montoUsd));
    }
    for (const v of ventasHac) {
      const k = `${v.centro}::VENTA_HACIENDA`;
      add(
        bucketReal,
        k,
        new Decimal(v.kgTotal ?? 0),
        new Decimal(v.kgTotal ?? 0).mul(v.usdKg ?? 0),
      );
    }
    for (const g of ventasGrano) {
      const k =
        g.tipo === 'FEEDLOT'
          ? 'AGR::VENTA_GRANO_FEEDLOT'
          : 'AGR::VENTA_GRANO';
      add(
        bucketReal,
        k,
        new Decimal(g.toneladas),
        new Decimal(g.toneladas).mul(g.precioNetoUsdT ?? 0),
      );
    }

    // Presupuesto
    for (const r of economico.rows) {
      const k = `${r.centro ?? 'SIN_CENTRO'}::${r.concepto}`;
      add(bucketPres, k, r.cantidad, r.montoUsd);
    }

    const items: any[] = [];
    for (const k of Array.from(claves).sort()) {
      const [centro, concepto] = k.split('::');
      const p = bucketPres.get(k) ?? { cantidad: new Decimal(0), monto: new Decimal(0) };
      const r = bucketReal.get(k) ?? { cantidad: new Decimal(0), monto: new Decimal(0) };
      const pP = p.cantidad.gt(0) ? p.monto.div(p.cantidad) : new Decimal(0);
      const pR = r.cantidad.gt(0) ? r.monto.div(r.cantidad) : new Decimal(0);
      const d = calcularDesvio({
        cantidadPresupuesto: p.cantidad,
        precioPresupuesto: pP,
        cantidadReal: r.cantidad,
        precioReal: pR,
      });
      items.push({
        centro,
        concepto,
        presupuestado: {
          cantidad: p.cantidad,
          precioUnitUsd: pP.toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN),
          montoUsd: d.presupuestadoUsd,
        },
        real: {
          cantidad: r.cantidad,
          precioUnitUsd: pR.toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN),
          montoUsd: d.realUsd,
        },
        desvio: {
          totalUsd: d.desvioTotalUsd,
          precioUsd: d.desvioPrecioUsd,
          cantidadUsd: d.desvioCantidadUsd,
        },
        alerta: pasaUmbral(d, {
          desvioUsd: cfg.desvioUsd,
          desvioPct: cfg.desvioPct,
        }),
      });
    }

    return {
      ejercicio: ej,
      escenario: economico.escenario,
      rango: { desde, hasta },
      items,
    };
  }
}

// Helper para satisfacer al type checker cuando el linter chilla por unused args.
function map1<K, V>(m: Map<K, V>, _k: K): Map<K, V> {
  return m;
}

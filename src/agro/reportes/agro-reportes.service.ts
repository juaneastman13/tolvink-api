import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AgroCentroTipo } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../database/prisma.service';
import {
  ejercicioDe,
  EjercicioConfig,
  nombreEjercicio,
  rangoDeEjercicio,
} from '../dominio/ejercicio';
import { aplicar, MovHacienda, StockMap, stockKey } from '../dominio/stock-hacienda';
import { calcularTanda } from '../dominio/feedlot';
import { MargenActividad, vistaEmpresa, vistaNegocios } from '../dominio/resultado-empresa';
import { kgCarneEquivalente, tSojaEquivalente } from '../dominio/equivalencias';

/**
 * Servicio que lee de la base y aplica las funciones puras de dominio.
 * Los endpoints en `AgroReportesController` sólo mapean parámetros y devuelven
 * lo que este servicio calcula.
 */
@Injectable()
export class AgroReportesService {
  constructor(private prisma: PrismaService) {}

  // ── Utilidades ────────────────────────────────────────────────────

  private async cfgEjercicio(empresaId: string): Promise<EjercicioConfig> {
    const cfg = await this.prisma.agroConfig.findUnique({ where: { empresaId } });
    if (!cfg) throw new NotFoundException('Falta AgroConfig para la empresa');
    return {
      mesInicioEjercicio: cfg.mesInicioEjercicio,
      cierreIntermedioMes: cfg.cierreIntermedioMes,
      cierreIntermedioDia: cfg.cierreIntermedioDia,
    };
  }

  private async rangoEjercicio(empresaId: string, ejercicio?: number) {
    const cfg = await this.cfgEjercicio(empresaId);
    const ej = ejercicio ?? ejercicioDe(cfg, new Date());
    const { desde, hasta } = rangoDeEjercicio(cfg, ej);
    return { cfg, ejercicio: ej, desde, hasta, nombre: nombreEjercicio(cfg, ej) };
  }

  // ── Stock ─────────────────────────────────────────────────────────

  async stockAt(empresaId: string, hasta: Date): Promise<StockMap> {
    const movs = await this.prisma.agroMovHacienda.findMany({
      where: { empresaId, fecha: { lte: hasta }, anuladoAt: null },
      orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
      select: {
        tipo: true,
        centro: true,
        categoriaCod: true,
        centroDestino: true,
        categoriaDestino: true,
        cabezas: true,
      },
    });
    const s: StockMap = new Map();
    for (const m of movs) aplicar(s, m as MovHacienda);
    return s;
  }

  // ── Resultados por actividad (§5.7) ──────────────────────────────

  async resultadosPorActividad(empresaId: string, ejercicio?: number) {
    const { cfg, ejercicio: ej, desde, hasta, nombre } = await this.rangoEjercicio(
      empresaId,
      ejercicio,
    );

    // Ingresos:
    //  · Hacienda: Σ(kgTotal × usdKg) por VENTA + ajuste por centro
    //  · Granos: Σ(toneladas × precioNetoUsdT) por VENTA + FEEDLOT
    //     - FEEDLOT: ingreso a AGR, costo a FEED (asiento gemelo §5.2)
    const [movsHacVenta, movsGranos, gastos, campos, config, tandas] = await Promise.all([
      this.prisma.agroMovHacienda.findMany({
        where: {
          empresaId,
          tipo: 'VENTA',
          fecha: { gte: desde, lte: hasta },
          anuladoAt: null,
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
        select: {
          tipo: true,
          toneladas: true,
          precioNetoUsdT: true,
          tandaId: true,
        },
      }),
      this.prisma.agroGasto.findMany({
        where: {
          empresaId,
          fecha: { gte: desde, lte: hasta },
          anuladoAt: null,
        },
        select: {
          centro: true,
          montoUsd: true,
          cuenta: { select: { tipo: true } },
        },
      }),
      this.prisma.agroCampo.findMany({
        where: { empresaId },
        select: { hectareas: true, propio: true, rentaUsdHaAno: true },
      }),
      this.prisma.agroConfig.findUnique({ where: { empresaId } }),
      this.prisma.agroTanda.findMany({
        where: { empresaId },
        select: { id: true },
      }),
    ]);

    const centros: AgroCentroTipo[] = ['CRI', 'REC', 'FEED', 'AGR', 'MAQ', 'PAS', 'EST'];
    const ingresos = new Map<AgroCentroTipo, Decimal>();
    const costosDirectos = new Map<AgroCentroTipo, Decimal>();
    for (const c of centros) {
      ingresos.set(c, new Decimal(0));
      costosDirectos.set(c, new Decimal(0));
    }

    for (const m of movsHacVenta) {
      const ing = new Decimal(m.kgTotal ?? 0).mul(m.usdKg ?? 0);
      ingresos.set(m.centro, (ingresos.get(m.centro) ?? new Decimal(0)).plus(ing));
    }

    let ingresoGranoFeedlotTotalUsd = new Decimal(0);
    for (const g of movsGranos) {
      if (!g.precioNetoUsdT) continue;
      const monto = new Decimal(g.toneladas).mul(g.precioNetoUsdT);
      if (g.tipo === 'VENTA') {
        ingresos.set('AGR', (ingresos.get('AGR') ?? new Decimal(0)).plus(monto));
      } else if (g.tipo === 'FEEDLOT') {
        // §5.2: ingreso a AGR y costo a FEED por el mismo importe.
        ingresos.set('AGR', (ingresos.get('AGR') ?? new Decimal(0)).plus(monto));
        costosDirectos.set('FEED', (costosDirectos.get('FEED') ?? new Decimal(0)).plus(monto));
        ingresoGranoFeedlotTotalUsd = ingresoGranoFeedlotTotalUsd.plus(monto);
      }
    }

    // Gastos: por centro, filtrados a tipos operativos (directos + indirectos)
    let estructuraNoAsignada = new Decimal(0);
    let intereses = new Decimal(0);
    for (const g of gastos) {
      const monto = new Decimal(g.montoUsd);
      const t = g.cuenta.tipo;
      if (t === 'ESTRUCTURA' && (g.centro === 'EST' || !g.centro)) {
        estructuraNoAsignada = estructuraNoAsignada.plus(monto);
      } else if (t === 'FINANCIERO') {
        intereses = intereses.plus(monto);
      } else {
        costosDirectos.set(
          g.centro,
          (costosDirectos.get(g.centro) ?? new Decimal(0)).plus(monto),
        );
      }
    }

    // Renta ficta / real de la tierra: reparto uniforme por defecto entre
    // AGR (agrícola) y suma CRI+REC (ganadería). Se afina con los % de
    // asignación cuando estén cargados en config.porcentajesAsignacion.tierra.
    let rentaFictaTotal = new Decimal(0);
    for (const c of campos) {
      if (!c.rentaUsdHaAno || !c.hectareas) continue;
      rentaFictaTotal = rentaFictaTotal.plus(new Decimal(c.hectareas).mul(c.rentaUsdHaAno));
    }
    const pctTierra =
      (config?.porcentajesAsignacion as any)?.tierra ??
      { AGR: 0.5, CRI: 0.25, REC: 0.25 };

    const rentaPorCentro = new Map<AgroCentroTipo, Decimal>();
    for (const c of centros) rentaPorCentro.set(c, new Decimal(0));
    for (const [c, pct] of Object.entries(pctTierra)) {
      rentaPorCentro.set(
        c as AgroCentroTipo,
        rentaFictaTotal.mul(pct as number).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
      );
    }

    const margenes: MargenActividad[] = centros
      .filter((c) => c !== 'EST' && c !== 'MAQ' && c !== 'PAS')
      .map((c) => ({
        centro: c,
        ingresosUsd: ingresos.get(c) ?? new Decimal(0),
        costosDirectosUsd: costosDirectos.get(c) ?? new Decimal(0),
        rentaTierraUsd: rentaPorCentro.get(c) ?? new Decimal(0),
      }));

    const vn = vistaNegocios(margenes);
    const ve = vistaEmpresa({
      margenes,
      rentaFictaTotalUsd: rentaFictaTotal,
      resultadoMaqUsd: 0, // TODO: consolidar en modo TARIFA cuando haya labores con tarifa
      estructuraNoAsignadaUsd: estructuraNoAsignada,
      amortizacionesNoAsignadasUsd: 0, // TODO: cuando se modele amortización
      interesesUsd: intereses,
      diferenciaCambioUsd: 0, // TODO
      resultadoTenenciaUsd: 0, // TODO cuando corra la descomposición de inventarios
    });

    return {
      ejercicio: ej,
      nombreEjercicio: nombre,
      rango: { desde, hasta },
      vistaNegocios: vn,
      vistaEmpresa: ve,
      transferenciaFeedlotUsd: ingresoGranoFeedlotTotalUsd.toDecimalPlaces(
        2,
        Decimal.ROUND_HALF_EVEN,
      ),
    };
  }

  // ── Tandas de feedlot (§5.9) ─────────────────────────────────────

  async reporteTandas(empresaId: string) {
    const tandas = await this.prisma.agroTanda.findMany({
      where: { empresaId },
      orderBy: { fechaIngreso: 'desc' },
    });

    const results: any[] = [];
    for (const t of tandas) {
      const [movsHac, movsGrano, gastos] = await Promise.all([
        this.prisma.agroMovHacienda.findMany({
          where: { empresaId, tandaId: t.id, anuladoAt: null },
          select: { tipo: true, cabezas: true, kgTotal: true, usdKg: true, fecha: true },
        }),
        this.prisma.agroMovGrano.findMany({
          where: { empresaId, tandaId: t.id, tipo: 'FEEDLOT', anuladoAt: null },
          select: { toneladas: true, precioNetoUsdT: true, producto: { select: { unidad: true } } },
        }),
        this.prisma.agroGasto.findMany({
          where: { empresaId, tandaId: t.id, anuladoAt: null },
          select: { montoUsd: true, cantidad: true, unidad: true },
        }),
      ]);

      // Cabezas entrada = COMPRA + TRANSF entrada (sumo cabezas, tomo primer y último kg)
      let cabezas = 0;
      let kgEntrada = new Decimal(0);
      let kgSalida = new Decimal(0);
      let ingreso = new Decimal(0);
      let fIngreso = t.fechaIngreso;
      let fSalida: Date | null = t.fechaCierre;
      for (const m of movsHac) {
        if (m.tipo === 'COMPRA') {
          cabezas += m.cabezas;
          kgEntrada = kgEntrada.plus(m.kgTotal ?? 0);
          if (m.fecha < fIngreso) fIngreso = m.fecha;
        }
        if (m.tipo === 'VENTA') {
          kgSalida = kgSalida.plus(m.kgTotal ?? 0);
          ingreso = ingreso.plus(new Decimal(m.kgTotal ?? 0).mul(m.usdKg ?? 0));
          if (!fSalida || m.fecha > fSalida) fSalida = m.fecha;
        }
        if (m.tipo === 'PESADA') {
          // Pesada más reciente aproxima kgSalida (para tandas aún abiertas)
          if (!kgSalida.gt(0)) kgSalida = new Decimal(m.kgTotal ?? 0);
        }
      }

      // Consumo MS: sumo toneladas de granos como kg (t × 1000) + racion cargada por gastos con unidad kg/ton
      let kgMs = new Decimal(0);
      let costoTransfInterna = new Decimal(0);
      for (const g of movsGrano) {
        const kg = new Decimal(g.toneladas).mul(1000);
        kgMs = kgMs.plus(kg);
        if (g.precioNetoUsdT) {
          costoTransfInterna = costoTransfInterna.plus(
            new Decimal(g.toneladas).mul(g.precioNetoUsdT),
          );
        }
      }
      for (const gg of gastos) {
        if (gg.unidad === 'KG' && gg.cantidad) kgMs = kgMs.plus(gg.cantidad);
        else if (gg.unidad === 'TON' && gg.cantidad)
          kgMs = kgMs.plus(new Decimal(gg.cantidad).mul(1000));
      }

      const costoTotalUsd = gastos.reduce<Decimal>(
        (a, g) => a.plus(new Decimal(g.montoUsd)),
        new Decimal(0),
      ).plus(costoTransfInterna);

      if (
        cabezas === 0 ||
        kgEntrada.lte(0) ||
        kgSalida.lte(0) ||
        kgSalida.lte(kgEntrada) ||
        !fSalida
      ) {
        results.push({
          tandaId: t.id,
          codigo: t.codigo,
          estado: fSalida ? 'INSUFICIENTES_DATOS' : 'ABIERTA',
          cabezas,
          fechaIngreso: fIngreso,
          fechaSalida: fSalida,
          kgEntradaTotal: kgEntrada,
          kgSalidaTotal: kgSalida,
        });
        continue;
      }

      try {
        const r = calcularTanda({
          cabezas,
          fechaIngreso: fIngreso,
          fechaSalida: fSalida,
          kgEntradaTotal: kgEntrada,
          kgSalidaTotal: kgSalida,
          kgMsConsumidos: kgMs,
          costoTotalUsd,
          ingresoTotalUsd: ingreso,
        });
        results.push({ tandaId: t.id, codigo: t.codigo, estado: 'CALCULADA', ...r });
      } catch (e: any) {
        results.push({
          tandaId: t.id,
          codigo: t.codigo,
          estado: 'ERROR',
          error: e.message,
        });
      }
    }
    return results;
  }

  // ── KPIs de empresa: equivalencias (§5.8) ────────────────────────

  async equivalenciasEmpresa(empresaId: string, ejercicio?: number) {
    const cfg = await this.prisma.agroConfig.findUnique({ where: { empresaId } });
    if (!cfg) throw new NotFoundException('Falta AgroConfig');
    if (new Decimal(cfg.pBaseCarne).lte(0) || new Decimal(cfg.pBaseSoja).lte(0)) {
      throw new BadRequestException(
        'Precios base fijos no configurados (config.pBaseCarne, pBaseSoja)',
      );
    }
    const { totalMbDespuesTierra } = (await this.resultadosPorActividad(empresaId, ejercicio))
      .vistaNegocios;
    return {
      kgCarneEquivalente: kgCarneEquivalente(totalMbDespuesTierra, {
        pBaseCarne: cfg.pBaseCarne,
        pBaseSoja: cfg.pBaseSoja,
      }),
      tSojaEquivalente: tSojaEquivalente(totalMbDespuesTierra, {
        pBaseCarne: cfg.pBaseCarne,
        pBaseSoja: cfg.pBaseSoja,
      }),
      baseMbUsd: totalMbDespuesTierra,
    };
  }

  // ── Ejercicio actual / helpers para el frontend ──────────────────

  async ejercicioActual(empresaId: string) {
    const cfg = await this.cfgEjercicio(empresaId);
    const ej = ejercicioDe(cfg, new Date());
    const { desde, hasta } = rangoDeEjercicio(cfg, ej);
    return { ejercicio: ej, nombre: nombreEjercicio(cfg, ej), desde, hasta };
  }
}

import {
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AgroEscenario } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf } from '../common/agro-base.controller';
import { MovMensual, proyectarCaja } from '../dominio/caja';
import { AgroPresupuestoService } from '../presupuesto/agro-presupuesto.controller';

/**
 * Flujo de caja rolling 12 meses (§6).
 *
 * Meses <= mesAnclaje: REAL (fechaCobroPago / fechaCobro / fechaPago).
 * Meses > mesAnclaje: PRESUPUESTO (agro_pres_económico bajo el escenario activo).
 * Saldo inicial: configurable por query `saldoInicial=`, default 0.
 * Alertas: rojo si saldo < 0, amarillo si saldo < `saldoMinimoOperativo` del config.
 */
@Injectable()
export class AgroCajaService {
  constructor(
    private prisma: PrismaService,
    private presupuesto: AgroPresupuestoService,
  ) {}

  private mesesVentana(from: Date): Array<{ ano: number; mes: number }> {
    const meses: Array<{ ano: number; mes: number }> = [];
    const y = from.getUTCFullYear();
    const m = from.getUTCMonth() + 1;
    for (let i = 0; i < 12; i++) {
      const totalMonth = m + i - 1;
      meses.push({
        ano: y + Math.floor(totalMonth / 12),
        mes: (totalMonth % 12) + 1,
      });
    }
    return meses;
  }

  async proyectar(
    empresaId: string,
    anclaje: Date,
    saldoInicialUsd: number,
    escenario?: AgroEscenario,
  ) {
    const cfg = await this.prisma.agroConfig.findUnique({ where: { empresaId } });
    if (!cfg) throw new NotFoundException('Falta AgroConfig');
    const escenarioUse = escenario ?? cfg.escenarioActivo;

    const ventana = this.mesesVentana(anclaje);
    const primer = ventana[0];
    const ultimo = ventana[ventana.length - 1];
    const desde = new Date(Date.UTC(primer.ano, primer.mes - 1, 1));
    const hastaExcl = new Date(Date.UTC(ultimo.ano, ultimo.mes, 1)); // 1er día del mes siguiente

    // Real: cobros de hacienda + granos + venta; pagos = gastos.
    const [ventasHac, ventasGranos, gastos] = await Promise.all([
      this.prisma.agroMovHacienda.findMany({
        where: {
          empresaId,
          anuladoAt: null,
          tipo: { in: ['VENTA', 'COMPRA'] },
          OR: [
            { fechaCobroPago: { gte: desde, lt: hastaExcl } },
            {
              AND: [
                { fechaCobroPago: null },
                { fecha: { gte: desde, lt: hastaExcl } },
              ],
            },
          ],
        },
        select: {
          tipo: true,
          fecha: true,
          fechaCobroPago: true,
          kgTotal: true,
          usdKg: true,
        },
      }),
      this.prisma.agroMovGrano.findMany({
        where: {
          empresaId,
          anuladoAt: null,
          tipo: 'VENTA',
          OR: [
            { fechaCobro: { gte: desde, lt: hastaExcl } },
            {
              AND: [
                { fechaCobro: null },
                { fecha: { gte: desde, lt: hastaExcl } },
              ],
            },
          ],
        },
        select: {
          fecha: true,
          fechaCobro: true,
          toneladas: true,
          precioNetoUsdT: true,
        },
      }),
      this.prisma.agroGasto.findMany({
        where: {
          empresaId,
          anuladoAt: null,
          OR: [
            { fechaPago: { gte: desde, lt: hastaExcl } },
            {
              AND: [
                { fechaPago: null },
                { fecha: { gte: desde, lt: hastaExcl } },
              ],
            },
          ],
        },
        select: { fecha: true, fechaPago: true, montoUsd: true },
      }),
    ]);

    // Acumulo por (año, mes)
    const map = new Map<string, { ingresos: Decimal; egresos: Decimal }>();
    const bump = (fecha: Date, ing = new Decimal(0), egr = new Decimal(0)) => {
      const k = `${fecha.getUTCFullYear()}-${fecha.getUTCMonth() + 1}`;
      const prev = map.get(k) ?? { ingresos: new Decimal(0), egresos: new Decimal(0) };
      prev.ingresos = prev.ingresos.plus(ing);
      prev.egresos = prev.egresos.plus(egr);
      map.set(k, prev);
    };
    for (const v of ventasHac) {
      const monto = new Decimal(v.kgTotal ?? 0).mul(v.usdKg ?? 0);
      const f = v.fechaCobroPago ?? v.fecha;
      if (v.tipo === 'VENTA') bump(f, monto);
      else bump(f, undefined, monto);
    }
    for (const g of ventasGranos) {
      const monto = new Decimal(g.toneladas).mul(g.precioNetoUsdT ?? 0);
      bump(g.fechaCobro ?? g.fecha, monto);
    }
    for (const gg of gastos) {
      bump(gg.fechaPago ?? gg.fecha, undefined, new Decimal(gg.montoUsd));
    }

    // Presupuesto: agrupo por mes del económico calculado. Distinguimos
    // ingresos vs egresos por convención: si el concepto empieza con "VENTA"
    // o "COBRO" o "INGRESO" → ingreso; si empieza con "COMPRA"/"PAGO"/"COSTO"
    // /"GASTO"/"INSUMO" → egreso. Los que no matchean van como ingreso 0.
    const eco = await this.presupuesto.calcularEconomico(
      empresaId,
      anclaje.getUTCFullYear(),
      escenarioUse,
    );
    const isIngreso = (c: string) =>
      /^(VENTA|COBRO|INGRESO)/i.test(c);
    const isEgreso = (c: string) =>
      /^(COMPRA|PAGO|COSTO|GASTO|INSUMO)/i.test(c);

    // Movs finales de la ventana: para meses ≤ anclaje uso real, para el resto presupuesto.
    const anclajeMes = anclaje.getUTCMonth() + 1;
    const anclajeAno = anclaje.getUTCFullYear();
    const movs: MovMensual[] = ventana.map((v) => {
      const esFuturo =
        v.ano > anclajeAno || (v.ano === anclajeAno && v.mes > anclajeMes);
      if (!esFuturo) {
        const bucket = map.get(`${v.ano}-${v.mes}`) ?? {
          ingresos: new Decimal(0),
          egresos: new Decimal(0),
        };
        return {
          ano: v.ano,
          mes: v.mes,
          ingresosUsd: bucket.ingresos,
          egresosUsd: bucket.egresos,
          origen: 'REAL',
        };
      }
      // Futuro: presupuesto
      let ing = new Decimal(0);
      let egr = new Decimal(0);
      for (const r of eco.rows) {
        if (r.mes !== v.mes) continue;
        if (isIngreso(r.concepto)) ing = ing.plus(r.montoUsd);
        else if (isEgreso(r.concepto)) egr = egr.plus(r.montoUsd);
      }
      return {
        ano: v.ano,
        mes: v.mes,
        ingresosUsd: ing,
        egresosUsd: egr,
        origen: 'PRESUPUESTO',
      };
    });

    return proyectarCaja(movs, saldoInicialUsd, cfg.saldoMinimoOperativo);
  }
}

@ApiTags('Agro / Caja')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/caja')
export class AgroCajaController {
  constructor(
    private service: AgroCajaService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async caja(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('anclaje') anclaje?: string,
    @Query('saldoInicial') saldoInicial?: string,
    @Query('escenario') escenario?: AgroEscenario,
  ) {
    const empresaId = await empresaIdOf(this.scope, user, req);
    const fecha = anclaje ? new Date(anclaje) : new Date();
    const saldo = saldoInicial ? Number(saldoInicial) : 0;
    return this.service.proyectar(empresaId, fecha, saldo, escenario);
  }
}

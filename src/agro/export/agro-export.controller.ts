import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, requireFecha } from '../common/agro-base.controller';
import { toCsv } from './csv';

type Dominio = 'hacienda' | 'granos' | 'gastos' | 'labores' | 'lluvias';

@Injectable()
export class AgroExportService {
  constructor(private prisma: PrismaService) {}

  async filas(
    empresaId: string,
    dominio: Dominio,
    desde?: Date,
    hasta?: Date,
  ): Promise<Array<Record<string, unknown>>> {
    const where: any = {
      empresaId,
      anuladoAt: null,
      ...(desde || hasta
        ? { fecha: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } }
        : {}),
    };
    switch (dominio) {
      case 'hacienda': {
        const rows = await this.prisma.agroMovHacienda.findMany({
          where,
          orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
        });
        return rows.map((m) => ({
          fecha: m.fecha,
          tipo: m.tipo,
          centro: m.centro,
          categoria: m.categoriaCod,
          centro_destino: m.centroDestino,
          categoria_destino: m.categoriaDestino,
          tanda_id: m.tandaId,
          cabezas: m.cabezas,
          kg_cab: m.kgCab ? Number(m.kgCab) : null,
          kg_total: m.kgTotal ? Number(m.kgTotal) : null,
          usd_kg: m.usdKg ? Number(m.usdKg) : null,
          prenadas: m.prenadas,
          tercero_id: m.terceroId,
          guia: m.guia,
          fecha_cobro_pago: m.fechaCobroPago,
          obs: m.obs,
          origen: m.origen,
        }));
      }
      case 'granos': {
        const rows = await this.prisma.agroMovGrano.findMany({
          where,
          orderBy: [{ fecha: 'asc' }],
          include: { producto: { select: { codigo: true } } },
        });
        return rows.map((m) => ({
          fecha: m.fecha,
          tipo: m.tipo,
          producto: m.producto?.codigo ?? m.productoId,
          toneladas: Number(m.toneladas),
          precio_neto_usd_t: m.precioNetoUsdT ? Number(m.precioNetoUsdT) : null,
          lote_campania_id: m.loteCampaniaId,
          tanda_id: m.tandaId,
          fecha_cobro: m.fechaCobro,
          obs: m.obs,
        }));
      }
      case 'gastos': {
        const rows = await this.prisma.agroGasto.findMany({
          where,
          orderBy: [{ fecha: 'asc' }],
          include: { cuenta: { select: { codigo: true } }, tercero: { select: { nombre: true } } },
        });
        return rows.map((g) => ({
          fecha: g.fecha,
          tercero: g.tercero?.nombre ?? '',
          cuenta: g.cuenta.codigo,
          centro: g.centro,
          detalle: g.detalle,
          moneda: g.moneda,
          monto: Number(g.monto),
          tipo_cambio: Number(g.tipoCambio),
          monto_usd: Number(g.montoUsd),
          cantidad: g.cantidad ? Number(g.cantidad) : null,
          unidad: g.unidad,
          fecha_pago: g.fechaPago,
          comprobante: g.comprobante,
        }));
      }
      case 'labores': {
        const rows = await this.prisma.agroLabor.findMany({ where, orderBy: [{ fecha: 'asc' }] });
        return rows.map((l) => ({
          fecha: l.fecha,
          lote_campania_id: l.loteCampaniaId,
          tipo_labor: l.tipoLabor,
          hectareas: Number(l.hectareas),
          propia: l.propia,
          tarifa_usd_ha: l.tarifaUsdHa ? Number(l.tarifaUsdHa) : null,
          obs: l.obs,
        }));
      }
      case 'lluvias': {
        const rows = await this.prisma.agroLluvia.findMany({ where, orderBy: [{ fecha: 'asc' }] });
        return rows.map((r) => ({
          fecha: r.fecha,
          mm: Number(r.mm),
          pluviometro: r.pluviometro,
        }));
      }
    }
  }

  /**
   * Genera un libro Excel con una hoja por dominio dentro de un rango de
   * fechas. Devuelve el buffer listo para escribir en la response.
   */
  async excelSnapshot(empresaId: string, desde: Date, hasta: Date): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Tolvink Agro';
    wb.created = new Date();
    const dominios: Dominio[] = ['hacienda', 'granos', 'gastos', 'labores', 'lluvias'];
    for (const dom of dominios) {
      const rows = await this.filas(empresaId, dom, desde, hasta);
      const ws = wb.addWorksheet(dom);
      if (rows.length > 0) {
        const headers = Object.keys(rows[0]);
        ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));
        for (const r of rows) ws.addRow(r);
        ws.getRow(1).font = { bold: true };
      } else {
        ws.addRow(['(sin datos en el rango)']);
      }
    }
    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}

@ApiTags('Agro / Export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/export')
export class AgroExportController {
  constructor(
    private service: AgroExportService,
    private scope: AgroScopeService,
  ) {}

  /**
   * CSV de un dominio. Header UTF-8+BOM, separador `;`, decimales con coma UY.
   * Se abre directo en Excel.
   */
  @Get(':dominio.csv')
  async csv(
    @CurrentUser() user: any,
    @Req() req: any,
    @Res() res: Response,
    @Param('dominio') dominio: Dominio,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    if (!['hacienda', 'granos', 'gastos', 'labores', 'lluvias'].includes(dominio)) {
      throw new BadRequestException('dominio inválido');
    }
    const empresaId = await empresaIdOf(this.scope, user, req);
    const rows = await this.service.filas(
      empresaId,
      dominio,
      desde ? requireFecha(desde) : undefined,
      hasta ? requireFecha(hasta) : undefined,
    );
    const csv = toCsv(rows);
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set(
        'Content-Disposition',
        `attachment; filename="agro-${dominio}-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .send(csv);
  }

  /**
   * Libro Excel con una hoja por dominio.
   */
  @Get('excel.xlsx')
  async excel(
    @CurrentUser() user: any,
    @Req() req: any,
    @Res() res: Response,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    const empresaId = await empresaIdOf(this.scope, user, req);
    const now = new Date();
    const desdeD = desde
      ? requireFecha(desde)
      : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const hastaD = hasta ? requireFecha(hasta) : now;
    const buffer = await this.service.excelSnapshot(empresaId, desdeD, hastaD);
    res
      .set(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .set(
        'Content-Disposition',
        `attachment; filename="agro-${desdeD.toISOString().slice(0, 10)}-${hastaD.toISOString().slice(0, 10)}.xlsx"`,
      )
      .send(buffer);
  }
}

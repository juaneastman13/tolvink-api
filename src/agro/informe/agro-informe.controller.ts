import {
  Controller,
  Get,
  Header,
  Injectable,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Decimal } from '@prisma/client/runtime/library';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf } from '../common/agro-base.controller';
import { AgroReportesService } from '../reportes/agro-reportes.service';

/**
 * Informe de socios (§6). Una página, textos generados automáticamente
 * a partir de los cálculos de reportes. Se sirve en dos formatos:
 *   - JSON: para que el frontend arme la vista con su design system.
 *   - HTML: print-friendly ("Guardar como PDF" desde el navegador). Evita
 *     agregar dependencia server-side de puppeteer/pdfkit.
 */
@Injectable()
export class AgroInformeService {
  constructor(private reportes: AgroReportesService) {}

  async informeSocios(empresaId: string, ejercicio?: number) {
    const [resultados, tandas, equivalencias, ejercicioActual] = await Promise.all([
      this.reportes.resultadosPorActividad(empresaId, ejercicio),
      this.reportes.reporteTandas(empresaId).catch(() => []),
      this.reportes
        .equivalenciasEmpresa(empresaId, ejercicio)
        .catch(() => null),
      this.reportes.ejercicioActual(empresaId),
    ]);

    const ve = resultados.vistaEmpresa;
    const vn = resultados.vistaNegocios;
    const nombreEj = resultados.nombreEjercicio;

    const totalMb = new Decimal(vn.totalMbDespuesTierra);
    const operativo = new Decimal(ve.resultadoOperativo);
    const neto = new Decimal(ve.resultadoNeto);
    const tenencia = new Decimal(ve.resultadoTenencia);

    // Textos ejecutivos generados a partir de los números.
    const narrativa: string[] = [];
    narrativa.push(
      `Cerramos el ejercicio ${nombreEj} con un resultado operativo de USD ${fmt(operativo)} y un resultado neto de USD ${fmt(neto)}.`,
    );
    if (!tenencia.eq(0)) {
      narrativa.push(
        `A eso se suma un ${tenencia.gt(0) ? 'ganancia' : 'pérdida'} por tenencia de USD ${fmt(tenencia.abs())}, que se muestra aparte del resultado operativo.`,
      );
    }
    const mejor = vn.porCentro.reduce<{ centro: string; mb: Decimal } | null>(
      (a, x) => {
        const mb = new Decimal(x.mbDespuesTierra);
        if (!a || mb.gt(a.mb)) return { centro: x.centro, mb };
        return a;
      },
      null,
    );
    const peor = vn.porCentro.reduce<{ centro: string; mb: Decimal } | null>(
      (a, x) => {
        const mb = new Decimal(x.mbDespuesTierra);
        if (!a || mb.lt(a.mb)) return { centro: x.centro, mb };
        return a;
      },
      null,
    );
    if (mejor && peor && mejor.centro !== peor.centro) {
      narrativa.push(
        `El mejor margen por actividad después de tierra vino de ${mejor.centro} (USD ${fmt(mejor.mb)}); el más bajo, ${peor.centro} (USD ${fmt(peor.mb)}).`,
      );
    }
    if (equivalencias) {
      narrativa.push(
        `Convertido a productividad física, el margen equivale a ${fmt(new Decimal(equivalencias.kgCarneEquivalente))} kg de carne o ${fmt(new Decimal(equivalencias.tSojaEquivalente))} t de soja (a precios base fijos).`,
      );
    }
    const tandasCalc = (tandas as any[]).filter((t) => t.estado === 'CALCULADA');
    if (tandasCalc.length > 0) {
      const totalMargen = tandasCalc.reduce<Decimal>(
        (a, t) => a.plus(new Decimal(t.margenTotalUsd ?? 0)),
        new Decimal(0),
      );
      narrativa.push(
        `Se cerraron ${tandasCalc.length} tandas de feedlot con un margen total de USD ${fmt(totalMargen)}.`,
      );
    }

    return {
      ejercicio: resultados.ejercicio,
      nombreEjercicio: nombreEj,
      rango: resultados.rango,
      narrativa,
      resumen: {
        totalMbDespuesTierra: vn.totalMbDespuesTierra,
        reversionRentaFicta: ve.reversionRentaFicta,
        resultadoMaq: ve.resultadoMaq,
        estructuraNoAsignada: ve.estructuraNoAsignada,
        resultadoOperativo: ve.resultadoOperativo,
        intereses: ve.intereses,
        diferenciaCambio: ve.diferenciaCambio,
        resultadoNeto: ve.resultadoNeto,
        resultadoTenencia: ve.resultadoTenencia,
      },
      porActividad: vn.porCentro,
      tandasFeedlot: tandasCalc,
      equivalencias,
    };
  }

  htmlInforme(data: any): string {
    const rows = (data.porActividad as any[])
      .map(
        (a) =>
          `<tr><td>${a.centro}</td><td class="num">USD ${fmt(new Decimal(a.mbDespuesTierra))}</td></tr>`,
      )
      .join('');
    const tandas = (data.tandasFeedlot as any[])
      .map(
        (t) =>
          `<tr><td>${t.codigo}</td><td>${t.diasEncierre}</td><td class="num">${fmt(new Decimal(t.gmdKgDia))} kg/día</td><td class="num">${fmt(new Decimal(t.margenPorCabezaUsd))}</td></tr>`,
      )
      .join('');
    const narrativa = (data.narrativa as string[])
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('');
    return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<title>Informe de socios — ${escapeHtml(data.nombreEjercicio)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #222; max-width: 780px; margin: auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 20px 0 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; }
  tr + tr td { border-top: 1px solid #eee; }
  th { background: #f5f5f5; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .kpi { display: flex; gap: 24px; margin: 12px 0; flex-wrap: wrap; }
  .kpi > div { border: 1px solid #ddd; padding: 8px 12px; border-radius: 6px; min-width: 150px; }
  .kpi label { display: block; color: #666; font-size: 11px; text-transform: uppercase; }
  .kpi strong { font-size: 18px; }
  p { line-height: 1.5; }
  @media print { .noprint { display: none; } }
</style>
</head><body>
<h1>Informe de socios — ejercicio ${escapeHtml(data.nombreEjercicio)}</h1>
<div class="meta">Del ${new Date(data.rango.desde).toLocaleDateString('es-UY')} al ${new Date(data.rango.hasta).toLocaleDateString('es-UY')}</div>

${narrativa}

<div class="kpi">
  <div><label>Resultado operativo</label><strong>USD ${fmt(new Decimal(data.resumen.resultadoOperativo))}</strong></div>
  <div><label>Resultado neto</label><strong>USD ${fmt(new Decimal(data.resumen.resultadoNeto))}</strong></div>
  <div><label>Tenencia (aparte)</label><strong>USD ${fmt(new Decimal(data.resumen.resultadoTenencia))}</strong></div>
</div>

<h2>Margen por actividad (después de tierra)</h2>
<table>
  <thead><tr><th>Actividad</th><th class="num">Margen USD</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

${tandas ? `
<h2>Tandas de feedlot</h2>
<table>
  <thead><tr><th>Tanda</th><th>Días</th><th class="num">GMD</th><th class="num">Margen/cab USD</th></tr></thead>
  <tbody>${tandas}</tbody>
</table>
` : ''}

${data.equivalencias ? `
<h2>Equivalencias (precios base fijos)</h2>
<p>
  kg de carne equivalente: <strong>${fmt(new Decimal(data.equivalencias.kgCarneEquivalente))}</strong>
  · t de soja equivalente: <strong>${fmt(new Decimal(data.equivalencias.tSojaEquivalente))}</strong>
</p>
` : ''}

<div class="noprint" style="margin-top:24px;color:#888;font-size:12px">
  Para guardar como PDF: Imprimir → Guardar como PDF.
</div>

</body></html>`;
  }
}

function fmt(d: Decimal): string {
  return d
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
    .toNumber()
    .toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@ApiTags('Agro / Informe')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/informe')
export class AgroInformeController {
  constructor(
    private service: AgroInformeService,
    private scope: AgroScopeService,
  ) {}

  @Get('socios.json')
  async json(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio?: string,
  ) {
    return this.service.informeSocios(
      await empresaIdOf(this.scope, user, req),
      ejercicio ? parseInt(ejercicio, 10) : undefined,
    );
  }

  @Get('socios.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async html(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio?: string,
  ) {
    const data = await this.service.informeSocios(
      await empresaIdOf(this.scope, user, req),
      ejercicio ? parseInt(ejercicio, 10) : undefined,
    );
    return this.service.htmlInforme(data);
  }
}

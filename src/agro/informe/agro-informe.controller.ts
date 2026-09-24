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
import { escapeHtml, TOLVINK_BASE_CSS, tolvinkHeader } from '../common/tolvink-theme';
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
      .map((a) => {
        const mb = Number(new Decimal(a.mbDespuesTierra));
        const cls = mb < 0 ? 'style="color:var(--danger)"' : '';
        return `<tr><td>${escapeHtml(a.centro)}</td><td class="num" ${cls}>USD ${fmt(new Decimal(a.mbDespuesTierra))}</td></tr>`;
      })
      .join('');
    const tandas = (data.tandasFeedlot as any[])
      .map(
        (t) =>
          `<tr><td>${escapeHtml(t.codigo)}</td><td class="num">${t.diasEncierre}</td><td class="num">${fmt(new Decimal(t.gmdKgDia))} kg/día</td><td class="num">USD ${fmt(new Decimal(t.margenPorCabezaUsd))}</td></tr>`,
      )
      .join('');
    const narrativa = (data.narrativa as string[])
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('');
    const desde = new Date(data.rango.desde).toLocaleDateString('es-UY');
    const hasta = new Date(data.rango.hasta).toLocaleDateString('es-UY');

    return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe de socios · ${escapeHtml(data.nombreEjercicio)} · Tolvink</title>
<style>${TOLVINK_BASE_CSS}
  @page { size: A4; margin: 16mm; }
  .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 640px) { .kpi-grid { grid-template-columns: 1fr; } }
  .kpi-tile { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
  .kpi-tile label { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .kpi-tile strong { display: block; font-size: 22px; color: var(--green-dark); font-variant-numeric: tabular-nums; font-weight: 700; }
  .kpi-tile.neg strong { color: var(--danger); }
  .kpi-tile .u { color: var(--muted); font-size: 12px; font-weight: 500; margin-left: 4px; }
  .narrativa p { margin: 0 0 10px; color: var(--ink); font-size: 14px; }
  .eq-line { color: var(--muted); font-size: 14px; }
  .eq-line strong { color: var(--green-dark); font-variant-numeric: tabular-nums; }
</style>
</head><body>
<main>
  ${tolvinkHeader(
    'Tolvink · Agro',
    [`Informe de socios · Ejercicio ${data.nombreEjercicio}`, `${desde} — ${hasta}`],
  )}

  <div class="card narrativa">
    ${narrativa}
  </div>

  <div class="kpi-grid">
    <div class="kpi-tile ${Number(data.resumen.resultadoOperativo) < 0 ? 'neg' : ''}">
      <label>Resultado operativo</label>
      <strong>${fmt(new Decimal(data.resumen.resultadoOperativo))}<span class="u">USD</span></strong>
    </div>
    <div class="kpi-tile ${Number(data.resumen.resultadoNeto) < 0 ? 'neg' : ''}">
      <label>Resultado neto</label>
      <strong>${fmt(new Decimal(data.resumen.resultadoNeto))}<span class="u">USD</span></strong>
    </div>
    <div class="kpi-tile ${Number(data.resumen.resultadoTenencia) < 0 ? 'neg' : ''}">
      <label>Tenencia (aparte)</label>
      <strong>${fmt(new Decimal(data.resumen.resultadoTenencia))}<span class="u">USD</span></strong>
    </div>
  </div>

  <div class="card">
    <h2>Margen por actividad — después de tierra</h2>
    <table class="data">
      <thead><tr><th>Actividad</th><th class="num">Margen USD</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  ${
    tandas
      ? `<div class="card">
    <h2>Tandas de feedlot</h2>
    <table class="data">
      <thead><tr><th>Tanda</th><th class="num">Días</th><th class="num">GMD</th><th class="num">Margen / cabeza</th></tr></thead>
      <tbody>${tandas}</tbody>
    </table>
  </div>`
      : ''
  }

  ${
    data.equivalencias
      ? `<div class="card">
    <h2>Equivalencias — precios base fijos</h2>
    <p class="eq-line">
      kg de carne equivalente: <strong>${fmt(new Decimal(data.equivalencias.kgCarneEquivalente))}</strong>
      · t de soja equivalente: <strong>${fmt(new Decimal(data.equivalencias.tSojaEquivalente))}</strong>
    </p>
  </div>`
      : ''
  }

  <div class="footer-note noprint">
    Para guardar como PDF: Imprimir → Guardar como PDF.
  </div>
</main>
</body></html>`;
  }
}

function fmt(d: Decimal): string {
  return d
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
    .toNumber()
    .toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BpsService } from './bps.service';

/**
 * Endpoints públicos de SOLO LECTURA para consumir el estado BPS desde
 * Excel / Power Query sin usuario Tolvink. Autenticación por token de
 * integración (?token=bps_...), revocable desde la app. No exponen
 * credenciales ni datos de cuenta — únicamente estados de certificados.
 */
@ApiTags('BPS Excel')
@Controller('bps/excel')
export class BpsExcelController {
  constructor(private readonly bpsService: BpsService) {}

  @Get('empresas')
  @ApiOperation({ summary: 'Empresas monitoreadas con su estado BPS (JSON o CSV para Power Query)' })
  async empresas(@Query('token') token: string, @Query('format') format: string, @Res() res: any) {
    const companyId = await this.bpsService.resolveToken(token);
    const rows = await this.bpsService.excelEmpresas(companyId);
    if (format === 'csv') {
      const header = 'rut,nombre,estado,vigente_hasta,ultima_consulta';
      const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      const lines = rows.map((r) => [r.rut, r.nombre, r.estado, r.vigenteHasta, r.ultimaConsulta].map((v) => esc(String(v))).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="bps-empresas.csv"');
      // BOM para que Excel abra los acentos correctamente
      return res.send('\uFEFF' + [header, ...lines].join('\r\n'));
    }
    return res.json(rows);
  }

  @Get('vigencia')
  @ApiOperation({ summary: 'Estado de vigencia de un RUT como texto plano (para =SERVICIOWEB)' })
  async vigencia(@Query('token') token: string, @Query('rut') rut: string, @Res() res: any) {
    const companyId = await this.bpsService.resolveToken(token);
    const estado = await this.bpsService.excelVigencia(companyId, rut);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(estado);
  }
}

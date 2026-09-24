import {
  BadRequestException,
  Body,
  Controller,
  Injectable,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { AgroCentroTipo, AgroMovHaciendaTipo, AgroMovGranoTipo, AgroUnidad } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf } from '../common/agro-base.controller';
import { normalizeFecha, num, parseTsv, requireNum } from './tsv-parser';
import { AgroHaciendaService } from '../hacienda/agro-hacienda.controller';
import { AgroGranosService } from '../granos/agro-granos.controller';
import { AgroGastosService } from '../gastos/agro-gastos.controller';
import { AgroLaboresService } from '../labores/agro-labores.controller';
import { AgroLluviasService } from '../lluvias/agro-lluvias.controller';

// ── DTO ───────────────────────────────────────────────────────────────

export type ImportDominio =
  | 'hacienda'
  | 'granos'
  | 'gastos'
  | 'labores'
  | 'lluvias';

export class ImportTsvDto {
  @IsIn(['hacienda', 'granos', 'gastos', 'labores', 'lluvias'])
  dominio!: ImportDominio;
  @IsString() tsv!: string;
  /** Si es true, no persiste: valida y devuelve el reporte de errores. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export interface ImportResult {
  ok: number;
  errors: Array<{ line: number; message: string }>;
  dryRun: boolean;
  dominio: ImportDominio;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroImportService {
  constructor(
    private hacienda: AgroHaciendaService,
    private granos: AgroGranosService,
    private gastos: AgroGastosService,
    private labores: AgroLaboresService,
    private lluvias: AgroLluviasService,
  ) {}

  async importar(
    empresaId: string,
    userId: string,
    dominio: ImportDominio,
    tsv: string,
    dryRun: boolean,
  ): Promise<ImportResult> {
    const rows = parseTsv(tsv);
    if (rows.length === 0) {
      throw new BadRequestException('TSV vacío o sin filas de datos');
    }

    const result: ImportResult = { ok: 0, errors: [], dryRun, dominio };

    for (const row of rows) {
      try {
        if (dryRun) {
          // Sólo mapeo y validación de shape del DTO.
          this.mapRow(dominio, row.raw);
        } else {
          const dto = this.mapRow(dominio, row.raw);
          await this.persistOne(empresaId, userId, dominio, dto);
        }
        result.ok++;
      } catch (e: any) {
        result.errors.push({
          line: row.lineNumber,
          message: e?.message || String(e),
        });
      }
    }
    return result;
  }

  private mapRow(dominio: ImportDominio, raw: Record<string, string>): any {
    switch (dominio) {
      case 'hacienda':
        return {
          fecha: this.requireFecha(raw, 'fecha'),
          tipo: this.enumFrom(AgroMovHaciendaTipo, raw['tipo'], 'tipo'),
          centro: this.enumFrom(AgroCentroTipo, raw['centro'], 'centro'),
          categoriaCod: this.requireStr(raw, 'categoria'),
          centroDestino: raw['centro_destino']
            ? this.enumFrom(AgroCentroTipo, raw['centro_destino'], 'centro_destino')
            : undefined,
          categoriaDestino: raw['categoria_destino'] || undefined,
          tandaId: raw['tanda_id'] || raw['lote'] || undefined,
          cabezas: requireNum(raw['cabezas'], 'cabezas'),
          kgCab: num(raw['kg_cab']) ?? undefined,
          kgTotal: num(raw['kg_total']) ?? undefined,
          usdKg: num(raw['usd_kg']) ?? undefined,
          prenadas: num(raw['prenadas']) ?? undefined,
          terceroId: raw['tercero_id'] || undefined,
          guia: raw['guia'] || undefined,
          obs: raw['obs'] || undefined,
          fechaCobroPago: normalizeFecha(raw['fecha_cobro_pago']) ?? undefined,
        };
      case 'granos':
        return {
          fecha: this.requireFecha(raw, 'fecha'),
          tipo: this.enumFrom(AgroMovGranoTipo, raw['tipo'], 'tipo'),
          loteCampaniaId: raw['lote_campania_id'] || undefined,
          productoId: this.requireStr(raw, 'producto_id'),
          toneladas: requireNum(raw['toneladas'], 'toneladas'),
          precioNetoUsdT: num(raw['precio_neto_usd_t']) ?? undefined,
          precioReferenciaUsdT: num(raw['precio_referencia_usd_t']) ?? undefined,
          fleteUsdT: num(raw['flete_usd_t']) ?? undefined,
          comisionUsdT: num(raw['comision_usd_t']) ?? undefined,
          fechaCobro: normalizeFecha(raw['fecha_cobro']) ?? undefined,
          tandaId: raw['tanda_id'] || undefined,
          obs: raw['obs'] || undefined,
        };
      case 'gastos':
        return {
          fecha: this.requireFecha(raw, 'fecha'),
          terceroId: raw['tercero_id'] || undefined,
          cuentaId: this.requireStr(raw, 'cuenta_id'),
          centro: this.enumFrom(AgroCentroTipo, raw['centro'], 'centro'),
          loteCampaniaId: raw['lote_campania_id'] || undefined,
          tandaId: raw['tanda_id'] || undefined,
          prestamoId: raw['prestamo_id'] || undefined,
          detalle: raw['detalle'] || undefined,
          moneda: this.requireMoneda(raw['moneda']),
          monto: requireNum(raw['monto'], 'monto'),
          tipoCambio: num(raw['tipo_cambio']) ?? undefined,
          comprobante: raw['comprobante'] || undefined,
          fechaPago: normalizeFecha(raw['fecha_pago']) ?? undefined,
          cantidad: num(raw['cantidad']) ?? undefined,
          unidad: raw['unidad']
            ? this.enumFrom(AgroUnidad, raw['unidad'], 'unidad')
            : undefined,
        };
      case 'labores':
        return {
          fecha: this.requireFecha(raw, 'fecha'),
          loteCampaniaId: this.requireStr(raw, 'lote_campania_id'),
          tipoLabor: this.requireStr(raw, 'tipo_labor'),
          hectareas: requireNum(raw['hectareas'], 'hectareas'),
          propia: this.parseBool(raw['propia']),
          tarifaUsdHa: num(raw['tarifa_usd_ha']) ?? undefined,
          obs: raw['obs'] || undefined,
        };
      case 'lluvias':
        return {
          fecha: this.requireFecha(raw, 'fecha'),
          mm: requireNum(raw['mm'], 'mm'),
          pluviometro: raw['pluviometro'] || undefined,
        };
    }
  }

  private async persistOne(
    empresaId: string,
    userId: string,
    dominio: ImportDominio,
    dto: any,
  ): Promise<void> {
    switch (dominio) {
      case 'hacienda':
        await this.hacienda.create(empresaId, userId, dto);
        return;
      case 'granos':
        await this.granos.create(empresaId, userId, dto);
        return;
      case 'gastos':
        await this.gastos.create(empresaId, userId, dto);
        return;
      case 'labores':
        await this.labores.create(empresaId, userId, dto);
        return;
      case 'lluvias':
        await this.lluvias.create(empresaId, userId, dto);
        return;
    }
  }

  // Helpers -------------------------------------------------------------

  private requireStr(raw: Record<string, string>, key: string): string {
    const v = raw[key]?.trim();
    if (!v) throw new Error(`${key} requerido`);
    return v;
  }

  private requireFecha(raw: Record<string, string>, key: string): string {
    const norm = normalizeFecha(raw[key]);
    if (!norm) throw new Error(`${key} requerido`);
    return norm;
  }

  private enumFrom<T extends Record<string, string>>(
    E: T,
    v: string | undefined,
    label: string,
  ): T[keyof T] {
    const t = v?.trim().toUpperCase();
    if (!t) throw new Error(`${label} requerido`);
    if (!(t in E)) {
      throw new Error(`${label} inválido "${v}"; valores: ${Object.keys(E).join('|')}`);
    }
    return E[t as keyof T];
  }

  private requireMoneda(v: string | undefined): 'USD' | 'UYU' {
    const t = v?.trim().toUpperCase();
    if (t !== 'USD' && t !== 'UYU') {
      throw new Error(`moneda inválida "${v}"; valores: USD|UYU`);
    }
    return t;
  }

  private parseBool(v: string | undefined): boolean {
    if (!v) return true; // default propia=true
    const t = v.trim().toLowerCase();
    return ['1', 'true', 'si', 'sí', 'yes', 'y', 'propia'].includes(t);
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/import')
export class AgroImportController {
  constructor(
    private service: AgroImportService,
    private scope: AgroScopeService,
  ) {}

  /**
   * Importa un TSV/CSV pegado. Cada fila se procesa aislada — un error en una
   * fila no aborta el resto. Retorna `{ ok, errors[] }`.
   *
   * Con `dryRun: true` se valida sin persistir.
   */
  @Post('tsv')
  @AgroRoles('agro_admin', 'agro_carga')
  async importTsv(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: ImportTsvDto,
  ) {
    return this.service.importar(
      await empresaIdOf(this.scope, user, req),
      user.sub,
      dto.dominio,
      dto.tsv,
      !!dto.dryRun,
    );
  }
}

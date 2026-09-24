import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, requireFecha } from '../common/agro-base.controller';
import { AgroEscenario } from '@prisma/client';
import { AgroReportesService } from './agro-reportes.service';
import { AgroDesviosService } from './agro-desvios.service';

/**
 * Endpoints de sólo-lectura para el tablero, el informe de socios y los KPI.
 * Todos accesibles por cualquier rol agro (incluyendo `agro_socio`).
 */
@ApiTags('Agro / Reportes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/reportes')
export class AgroReportesController {
  constructor(
    private service: AgroReportesService,
    private desvios: AgroDesviosService,
    private scope: AgroScopeService,
  ) {}

  @Get('ejercicio-actual')
  async ejercicioActual(@CurrentUser() user: any, @Req() req: any) {
    return this.service.ejercicioActual(await empresaIdOf(this.scope, user, req));
  }

  /**
   * Snapshot de stock de hacienda a una fecha, agrupado por (centro, categoría).
   */
  @Get('stock')
  async stock(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('hasta') hasta?: string,
  ) {
    const empresaId = await empresaIdOf(this.scope, user, req);
    const fecha = hasta ? requireFecha(hasta) : new Date();
    const s = await this.service.stockAt(empresaId, fecha);
    return Array.from(s.entries())
      .filter(([, n]) => n !== 0)
      .map(([k, cabezas]) => {
        const [centro, categoriaCod] = k.split('::');
        return { centro, categoriaCod, cabezas };
      });
  }

  /**
   * Resultados por actividad — vista negocios y vista empresa (§5.7).
   */
  @Get('resultados')
  async resultados(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio?: string,
  ) {
    return this.service.resultadosPorActividad(
      await empresaIdOf(this.scope, user, req),
      ejercicio ? parseInt(ejercicio, 10) : undefined,
    );
  }

  /**
   * Reporte por tanda de feedlot (§5.9): GMD, conversión, costo/kg ganado,
   * margen por cabeza y por día, precio de equilibrio.
   */
  @Get('tandas')
  async tandas(@CurrentUser() user: any, @Req() req: any) {
    return this.service.reporteTandas(await empresaIdOf(this.scope, user, req));
  }

  /**
   * KPIs de equivalencias carne/soja (§5.8) con precios base fijos.
   */
  @Get('equivalencias')
  async equivalencias(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio?: string,
  ) {
    return this.service.equivalenciasEmpresa(
      await empresaIdOf(this.scope, user, req),
      ejercicio ? parseInt(ejercicio, 10) : undefined,
    );
  }

  /**
   * §6 — Presupuesto vs Real por (centro, concepto), con descomposición
   * precio/cantidad y alertas según config.desvioUsd/desvioPct.
   */
  @Get('desvios')
  async desviosPresupuestoVsReal(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio?: string,
    @Query('escenario') escenario?: AgroEscenario,
  ) {
    return this.desvios.presupuestoVsReal(
      await empresaIdOf(this.scope, user, req),
      ejercicio ? parseInt(ejercicio, 10) : undefined,
      escenario,
    );
  }
}

import {
  Body,
  Controller,
  Get,
  Header,
  Injectable,
  Param,
  Post,
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
import { empresaIdOf } from '../common/agro-base.controller';
import { calcularMomentoVenta, MomentoVentaParams } from '../dominio/decisiones/momento-venta';
import {
  calcularPrecioMaxReposicion,
  PrecioMaxParams,
} from '../dominio/decisiones/precio-max-reposicion';
import { calcularFertilizacion, FertilizacionParams } from '../dominio/decisiones/fertilizacion';
import { calcularVanPasturas, VanPasturasParams } from '../dominio/decisiones/van-pasturas';
import { calcularMaquinaria, MaquinariaParams } from '../dominio/decisiones/maquinaria';
import {
  calcularComercializacion,
  ComercializacionParams,
} from '../dominio/decisiones/comercializacion-granos';
import { calcularCompraInsumos, CompraInsumosParams } from '../dominio/decisiones/compra-insumos';
import { calcularRentaMax, RentaMaxParams } from '../dominio/decisiones/renta-max';
import { calcularRecomposicion, RecomposicionParams } from '../dominio/decisiones/recomposicion';
import { DecisionResultado } from '../dominio/decisiones/tipos';
import { renderDecisionHtml } from './render-html';

/**
 * Fase 7 — Modelos de decisión.
 *
 * Cada endpoint acepta parámetros por POST (body JSON) y devuelve un
 * `DecisionResultado<T>` con el mismo shape para que el frontend pueda
 * renderizar la misma vista genérica (KPI + curva + heatmap + alertas).
 *
 * Además, `GET /agro/decisiones/:tipo.html?...params...` devuelve la
 * misma decisión ya renderizada como HTML print-friendly con SVG inline
 * (útil para vista rápida sin frontend). Los parámetros vienen en el
 * body JSON codificado en `?data=<base64(json)>`.
 */
@Injectable()
export class AgroDecisionesService {
  /** Dispatch para el render HTML por GET (dev/preview). */
  runByTipo(
    tipo: string,
    params: any,
  ): DecisionResultado<any> | { error: string } {
    switch (tipo) {
      case 'momento-venta':
        return calcularMomentoVenta(params as MomentoVentaParams);
      case 'precio-max-reposicion':
        return calcularPrecioMaxReposicion(params as PrecioMaxParams);
      case 'fertilizacion':
        return calcularFertilizacion(params as FertilizacionParams);
      case 'van-pasturas':
        return calcularVanPasturas(params as VanPasturasParams);
      case 'maquinaria':
        return calcularMaquinaria(params as MaquinariaParams);
      case 'comercializacion-granos':
        return calcularComercializacion(params as ComercializacionParams);
      case 'compra-insumos':
        return calcularCompraInsumos(params as CompraInsumosParams);
      case 'renta-max':
        return calcularRentaMax(params as RentaMaxParams);
      case 'recomposicion':
        return calcularRecomposicion(params as RecomposicionParams);
      default:
        return { error: `tipo desconocido: ${tipo}` };
    }
  }

  decodeParams(qData: string | undefined): any {
    if (!qData) return {};
    try {
      const json = Buffer.from(qData, 'base64').toString('utf-8');
      return JSON.parse(json);
    } catch {
      return {};
    }
  }
}

@ApiTags('Agro / Decisiones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/decisiones')
export class AgroDecisionesController {
  constructor(
    private service: AgroDecisionesService,
    private scope: AgroScopeService,
  ) {}

  @Post('momento-venta')
  momentoVenta(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: MomentoVentaParams,
  ) {
    return this.tap(user, req, calcularMomentoVenta(dto));
  }

  @Post('precio-max-reposicion')
  precioMax(@CurrentUser() u: any, @Req() r: any, @Body() dto: PrecioMaxParams) {
    return this.tap(u, r, calcularPrecioMaxReposicion(dto));
  }

  @Post('fertilizacion')
  fertilizacion(@CurrentUser() u: any, @Req() r: any, @Body() dto: FertilizacionParams) {
    return this.tap(u, r, calcularFertilizacion(dto));
  }

  @Post('van-pasturas')
  vanPasturas(@CurrentUser() u: any, @Req() r: any, @Body() dto: VanPasturasParams) {
    return this.tap(u, r, calcularVanPasturas(dto));
  }

  @Post('maquinaria')
  maquinaria(@CurrentUser() u: any, @Req() r: any, @Body() dto: MaquinariaParams) {
    return this.tap(u, r, calcularMaquinaria(dto));
  }

  @Post('comercializacion-granos')
  comercializacion(
    @CurrentUser() u: any,
    @Req() r: any,
    @Body() dto: ComercializacionParams,
  ) {
    return this.tap(u, r, calcularComercializacion(dto));
  }

  @Post('compra-insumos')
  compraInsumos(
    @CurrentUser() u: any,
    @Req() r: any,
    @Body() dto: CompraInsumosParams,
  ) {
    return this.tap(u, r, calcularCompraInsumos(dto));
  }

  @Post('renta-max')
  rentaMax(@CurrentUser() u: any, @Req() r: any, @Body() dto: RentaMaxParams) {
    return this.tap(u, r, calcularRentaMax(dto));
  }

  @Post('recomposicion')
  recomposicion(
    @CurrentUser() u: any,
    @Req() r: any,
    @Body() dto: RecomposicionParams,
  ) {
    return this.tap(u, r, calcularRecomposicion(dto));
  }

  /**
   * GET :tipo.html?data=<base64(json)>
   *
   * Vista HTML print-friendly con SVG inline (curva + heatmap + KPIs). El
   * frontend puede iframear esto para tener una vista instantánea sin
   * armar componentes; el usuario puede "Guardar como PDF" desde el
   * navegador.
   */
  @Get(':tipo.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async html(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('tipo') tipo: string,
    @Query('data') dataB64?: string,
  ) {
    await empresaIdOf(this.scope, user, req); // validación de acceso
    const params = this.service.decodeParams(dataB64);
    const out = this.service.runByTipo(tipo, params);
    if ('error' in out) {
      return `<h1>Error</h1><p>${out.error}</p>`;
    }
    return renderDecisionHtml(tipo, out);
  }

  private tap<T>(_user: any, _req: any, result: T): T {
    return result;
  }
}

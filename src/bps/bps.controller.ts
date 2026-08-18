import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConectarCuentaDto, ConsultarCertificadoDto, MonitorearEmpresaDto, UpdateBpsConfigDto } from './bps.dto';
import { BpsService } from './bps.service';

const BPS_ROLES = ['producer', 'plant', 'transporter', 'platform_admin'] as const;

@ApiTags('BPS')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bps')
export class BpsController {
  constructor(private readonly bpsService: BpsService) {}

  // ── Consulta pública de vigencia ──

  @Post('certificados/consultar')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  @ApiOperation({ summary: 'Consulta la vigencia del certificado común BPS de un RUT' })
  consultarCertificado(@CurrentUser() user: any, @Body() dto: ConsultarCertificadoDto) {
    return this.bpsService.consultarCertificado(user, dto);
  }

  // ── Monitoreo automático ──

  @Get('empresas')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  listEmpresas(@CurrentUser() user: any) {
    return this.bpsService.listEmpresas(user);
  }

  @Post('empresas')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  monitorearEmpresa(@CurrentUser() user: any, @Body() dto: MonitorearEmpresaDto) {
    return this.bpsService.monitorearEmpresa(user, dto);
  }

  @Patch('empresas/:id/delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  quitarEmpresa(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.bpsService.quitarEmpresa(user, id);
  }

  @Get('empresas/:id/historial')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  historial(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.bpsService.historial(user, id);
  }

  @Get('config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  getConfig(@CurrentUser() user: any) {
    return this.bpsService.getConfig(user);
  }

  @Patch('config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  updateConfig(@CurrentUser() user: any, @Body() dto: UpdateBpsConfigDto) {
    return this.bpsService.updateConfig(user, dto);
  }

  // ── Cuenta autenticada (usuario BPS de la empresa) ──

  @Get('cuenta')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  @ApiOperation({ summary: 'Estado de la cuenta BPS conectada (usuario enmascarado, nunca la credencial)' })
  getCuenta(@CurrentUser() user: any) {
    return this.bpsService.getCuenta(user);
  }

  @Post('cuenta/conectar')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  @ApiOperation({ summary: 'Prueba las credenciales BPS en vivo y las guarda cifradas' })
  conectarCuenta(@CurrentUser() user: any, @Body() dto: ConectarCuentaDto) {
    return this.bpsService.conectarCuenta(user, dto);
  }

  @Patch('cuenta/desconectar')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  desconectarCuenta(@CurrentUser() user: any) {
    return this.bpsService.desconectarCuenta(user);
  }

  @Post('cuenta/sincronizar')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  @ApiOperation({ summary: 'Ejecuta ahora las consultas autenticadas (observaciones, obligaciones, nómina)' })
  sincronizarCuenta(@CurrentUser() user: any) {
    return this.bpsService.sincronizarCuenta(user);
  }

  @Get('cuenta/datos')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  getDatosCuenta(@CurrentUser() user: any) {
    return this.bpsService.getDatosCuenta(user);
  }

  // ── Token de integración (Excel / Power Query) ──

  @Get('token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  @ApiOperation({ summary: 'Estado del token de integración (nunca devuelve el valor)' })
  getToken(@CurrentUser() user: any) {
    return this.bpsService.getTokenInfo(user);
  }

  @Post('token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  @ApiOperation({ summary: 'Genera o regenera el token de integración — el valor se muestra una sola vez' })
  crearToken(@CurrentUser() user: any) {
    return this.bpsService.crearToken(user);
  }

  @Patch('token/revoke')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BPS_ROLES)
  revocarToken(@CurrentUser() user: any) {
    return this.bpsService.revocarToken(user);
  }
}

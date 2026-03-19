import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FieldsService } from './fields.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto, ImportConfirmDto, ImportParseLinksDto, ImportGoogleListDto, CreatePoiDto, UpdatePoiDto, SharePoiDto, UnsharePoiDto, ReclassifyPoiDto, ShareFieldDto, UnshareFieldDto, ShareLotDto, UnshareLotDto } from './fields.dto';

@ApiTags('Fields')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('fields')
export class FieldsController {
  constructor(private readonly service: FieldsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar campos del usuario con sus lotes' })
  @ApiQuery({ name: 'ownerCompanyId', required: false })
  getFields(@CurrentUser() user: any, @Query('ownerCompanyId') ownerCompanyId?: string) {
    if (ownerCompanyId && !/^[0-9a-f-]{36}$/i.test(ownerCompanyId)) {
      throw new BadRequestException('ownerCompanyId inválido');
    }
    return this.service.getFields(user, ownerCompanyId);
  }

  @Get('owners-summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Resumen de campos por empresa dueña (vista planta)' })
  getOwnersSummary(@CurrentUser() user: any) {
    return this.service.getOwnersSummary(user);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Crear un campo' })
  createField(@CurrentUser() user: any, @Body() dto: CreateFieldDto) {
    return this.service.createField(user, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Editar un campo (ubicación, dirección)' })
  updateField(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFieldDto,
  ) {
    return this.service.updateField(user, id, dto);
  }

  @Get(':fieldId/lots')
  @ApiOperation({ summary: 'Listar lotes de un campo' })
  getLots(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
  ) {
    return this.service.getLots(user, fieldId);
  }

  @Post(':fieldId/lots')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Crear un lote dentro de un campo' })
  createLot(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: CreateLotDto,
  ) {
    return this.service.createLot(user, fieldId, dto);
  }

  @Patch(':fieldId/lots/:lotId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Editar un lote (hectáreas, ubicación)' })
  updateLot(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: UpdateLotDto,
  ) {
    return this.service.updateLot(user, fieldId, lotId, dto);
  }

  // ── Share / Delete Fields ────────────────────────────────────────

  @Post(':fieldId/share')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Compartir un campo con otro usuario' })
  shareField(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: ShareFieldDto,
  ) {
    return this.service.shareField(user, fieldId, dto);
  }

  @Patch(':fieldId/unshare')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Dejar de compartir un campo con un usuario' })
  unshareField(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: UnshareFieldDto,
  ) {
    return this.service.unshareField(user, fieldId, dto);
  }

  @Get(':fieldId/shares')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Listar usuarios con quienes se compartió un campo' })
  getFieldShares(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
  ) {
    return this.service.getFieldShares(user, fieldId);
  }

  @Patch(':fieldId/delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Eliminar un campo (soft delete, cascade lotes)' })
  deleteField(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
  ) {
    return this.service.deleteField(user, fieldId);
  }

  // ── Share / Delete Lots ─────────────────────────────────────────

  @Post(':fieldId/lots/:lotId/share')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Compartir un lote con otro usuario' })
  shareLot(
    @CurrentUser() user: any,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: ShareLotDto,
  ) {
    return this.service.shareLot(user, lotId, dto);
  }

  @Patch(':fieldId/lots/:lotId/unshare')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Dejar de compartir un lote con un usuario' })
  unshareLot(
    @CurrentUser() user: any,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: UnshareLotDto,
  ) {
    return this.service.unshareLot(user, lotId, dto);
  }

  @Get(':fieldId/lots/:lotId/shares')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Listar usuarios con quienes se compartió un lote' })
  getLotShares(
    @CurrentUser() user: any,
    @Param('lotId', ParseUUIDPipe) lotId: string,
  ) {
    return this.service.getLotShares(user, lotId);
  }

  @Patch(':fieldId/lots/:lotId/delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Eliminar un lote (soft delete)' })
  deleteLot(
    @CurrentUser() user: any,
    @Param('lotId', ParseUUIDPipe) lotId: string,
  ) {
    return this.service.deleteLot(user, lotId);
  }

  // ── Points of Interest ──────────────────────────────────────────

  @Get('pois/search-users')
  @ApiOperation({ summary: 'Buscar usuarios para compartir ubicaciones' })
  searchUsersForShare(
    @CurrentUser() user: any,
    @Query('q') query: string,
  ) {
    return this.service.searchUsersForShare(user, query);
  }

  @Get('pois')
  @ApiOperation({ summary: 'Listar ubicaciones de interés del usuario' })
  getPois(@CurrentUser() user: any) {
    return this.service.getPois(user);
  }

  @Post('pois')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Crear una ubicación de interés' })
  createPoi(@CurrentUser() user: any, @Body() dto: CreatePoiDto) {
    return this.service.createPoi(user, dto);
  }

  @Patch('pois/:poiId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Editar una ubicación de interés' })
  updatePoi(
    @CurrentUser() user: any,
    @Param('poiId', ParseUUIDPipe) poiId: string,
    @Body() dto: UpdatePoiDto,
  ) {
    return this.service.updatePoi(user, poiId, dto);
  }

  @Patch('pois/:poiId/delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Eliminar una ubicación de interés (soft delete)' })
  deletePoi(
    @CurrentUser() user: any,
    @Param('poiId', ParseUUIDPipe) poiId: string,
  ) {
    return this.service.deletePoi(user, poiId);
  }

  // ── Share POIs ─────────────────────────────────────────────────────

  @Post('pois/:poiId/share')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Compartir una ubicación de interés con otro usuario' })
  sharePoi(
    @CurrentUser() user: any,
    @Param('poiId', ParseUUIDPipe) poiId: string,
    @Body() dto: SharePoiDto,
  ) {
    return this.service.sharePoi(user, poiId, dto);
  }

  @Patch('pois/:poiId/unshare')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Dejar de compartir una ubicación con un usuario' })
  unsharePoi(
    @CurrentUser() user: any,
    @Param('poiId', ParseUUIDPipe) poiId: string,
    @Body() dto: UnsharePoiDto,
  ) {
    return this.service.unsharePoi(user, poiId, dto);
  }

  @Get('pois/:poiId/shares')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Listar usuarios con quienes se compartió una ubicación' })
  getPoiShares(
    @CurrentUser() user: any,
    @Param('poiId', ParseUUIDPipe) poiId: string,
  ) {
    return this.service.getPoiShares(user, poiId);
  }

  // ── Reclassify POI ────────────────────────────────────────────────

  @Post('pois/:poiId/reclassify')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Reclasificar una ubicación de interés como Campo o Lote' })
  reclassifyPoi(
    @CurrentUser() user: any,
    @Param('poiId', ParseUUIDPipe) poiId: string,
    @Body() dto: ReclassifyPoiDto,
  ) {
    return this.service.reclassifyPoi(user, poiId, dto);
  }

  // ── Google Maps Link Import ──────────────────────────────────────

  @Post('import-google-list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Parsear link de lista compartida de Google Maps y devolver ubicaciones' })
  importGoogleList(@Body() dto: ImportGoogleListDto) {
    return this.service.importGoogleList(dto.url);
  }

  @Post('import-links')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Parsear links de Google Maps compartidos y devolver ubicaciones' })
  importLinks(
    @Body() dto: ImportParseLinksDto,
  ) {
    return this.service.parseGoogleLinks(dto.text);
  }

  @Post('import-confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiOperation({ summary: 'Confirmar e importar ubicaciones como campos' })
  importConfirm(
    @CurrentUser() user: any,
    @Body() dto: ImportConfirmDto,
  ) {
    return this.service.importConfirm(user, dto);
  }
}

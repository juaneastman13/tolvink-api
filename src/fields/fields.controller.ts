import { Controller, Get, Post, Patch, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FieldsService } from './fields.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto, ImportConfirmDto, ImportParseLinksDto, ImportGoogleListDto, CreatePoiDto } from './fields.dto';

@ApiTags('Fields')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('fields')
export class FieldsController {
  constructor(private readonly service: FieldsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar campos del usuario con sus lotes' })
  getFields(@CurrentUser() user: any) {
    return this.service.getFields(user);
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

  // ── Points of Interest ──────────────────────────────────────────

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

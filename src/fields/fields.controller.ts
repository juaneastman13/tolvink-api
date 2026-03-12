import { Controller, Get, Post, Patch, Param, Body, UseGuards, UseInterceptors, UploadedFile, ParseUUIDPipe, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FieldsService } from './fields.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto, ImportConfirmDto } from './fields.dto';

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

  // ── Google Takeout Import ──────────────────────────────────────────

  @Post('import-takeout')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Parsear ZIP de Google Takeout y devolver ubicaciones' })
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname?.endsWith('.zip')) {
        cb(null, true);
      } else {
        cb(new BadRequestException('Solo se aceptan archivos .zip'), false);
      }
    },
  }))
  importTakeout(
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file || !file.buffer) throw new BadRequestException('Archivo requerido');
    return this.service.parseTakeoutZip(file.buffer);
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

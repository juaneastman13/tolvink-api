import { Controller, Get, Post, Patch, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FieldsService } from './fields.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto } from './fields.dto';

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
  @ApiOperation({ summary: 'Crear un campo' })
  createField(@CurrentUser() user: any, @Body() dto: CreateFieldDto) {
    return this.service.createField(user, dto);
  }

  @Patch(':id')
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
  @ApiOperation({ summary: 'Crear un lote dentro de un campo' })
  createLot(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: CreateLotDto,
  ) {
    return this.service.createLot(user, fieldId, dto);
  }

  @Patch(':fieldId/lots/:lotId')
  @ApiOperation({ summary: 'Editar un lote (hectáreas, ubicación)' })
  updateLot(
    @CurrentUser() user: any,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: UpdateLotDto,
  ) {
    return this.service.updateLot(user, fieldId, lotId, dto);
  }
}

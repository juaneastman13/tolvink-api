import { Controller, Get, Post, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { FreightsService } from './freights.service';
import { CreateFreightDto, AssignFreightDto, RespondAssignmentDto, CancelFreightDto } from './freights.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Freights')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('freights')
export class FreightsController {
  constructor(private service: FreightsService) {}

  @Post()
  @Roles('producer', 'plant')
  @ApiOperation({ summary: 'Crear flete (productor o planta)' })
  create(@Body() dto: CreateFreightDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'Listar fletes (filtrado por empresa)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll(user, {
      status,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get(':id')
  @UseGuards(FreightAccessGuard)
  @ApiOperation({ summary: 'Detalle de flete' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post(':id/assign')
  @UseGuards(FreightAccessGuard)
  @Roles('plant')
  @ApiOperation({ summary: 'Asignar transportista (solo planta)' })
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignFreightDto,
    @CurrentUser() user: any,
  ) {
    return this.service.assign(id, dto, user);
  }

  @Post(':id/respond')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter')
  @ApiOperation({ summary: 'Aceptar o rechazar asignación (solo transportista)' })
  respond(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondAssignmentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.respond(id, dto, user);
  }

  @Post(':id/start')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter')
  @ApiOperation({ summary: 'Iniciar viaje' })
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.start(id, user);
  }

  @Post(':id/finish')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'plant')
  @ApiOperation({ summary: 'Finalizar viaje' })
  finish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.finish(id, user);
  }

  @Post(':id/cancel')
  @UseGuards(FreightAccessGuard)
  @ApiOperation({ summary: 'Cancelar flete (motivo obligatorio)' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelFreightDto,
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(id, dto, user);
  }
}

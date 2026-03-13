import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { WeighTicketsService } from './weigh-tickets.service';
import { CreateWeighTicketDto, UpdateWeighTicketDto } from './weigh-tickets.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Weigh Tickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('freights/:id/weigh-tickets')
export class WeighTicketsController {
  constructor(private service: WeighTicketsService) {}

  @Post()
  @UseGuards(FreightAccessGuard)
  @Roles('plant', 'transporter', 'producer')
  @ApiOperation({ summary: 'Crear ticket de pesaje para un flete' })
  create(
    @Param('id', ParseUUIDPipe) freightId: string,
    @Body() dto: CreateWeighTicketDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(freightId, dto, user);
  }

  @Get()
  @UseGuards(FreightAccessGuard)
  @ApiOperation({ summary: 'Listar tickets de pesaje de un flete' })
  @ApiQuery({ name: 'type', required: false, enum: ['origin', 'destination'] })
  findAll(
    @Param('id', ParseUUIDPipe) freightId: string,
    @Query('type') type?: string,
  ) {
    return this.service.findAll(freightId, type);
  }

  @Get(':ticketId')
  @UseGuards(FreightAccessGuard)
  @ApiOperation({ summary: 'Detalle de un ticket de pesaje' })
  findOne(
    @Param('id', ParseUUIDPipe) freightId: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
  ) {
    return this.service.findOne(freightId, ticketId);
  }

  @Patch(':ticketId')
  @UseGuards(FreightAccessGuard)
  @Roles('plant', 'transporter', 'producer')
  @ApiOperation({ summary: 'Editar ticket de pesaje' })
  update(
    @Param('id', ParseUUIDPipe) freightId: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: UpdateWeighTicketDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(freightId, ticketId, dto, user);
  }

  @Delete(':ticketId')
  @UseGuards(FreightAccessGuard)
  @Roles('plant')
  @ApiOperation({ summary: 'Eliminar ticket de pesaje (solo planta)' })
  remove(
    @Param('id', ParseUUIDPipe) freightId: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
  ) {
    return this.service.remove(freightId, ticketId);
  }

  @Post(':ticketId/ocr')
  @UseGuards(FreightAccessGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Roles('plant', 'transporter', 'producer')
  @ApiOperation({ summary: 'Ejecutar OCR sobre la foto del ticket de pesaje' })
  runOcr(
    @Param('id', ParseUUIDPipe) freightId: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
  ) {
    return this.service.runOcr(freightId, ticketId);
  }
}

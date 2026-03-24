import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, ParseUUIDPipe, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { FreightsService } from './freights.service';
import { AssignmentSuggestionsService } from './assignment-suggestions.service';
import { CreateFreightDto, AssignFreightDto, RespondAssignmentDto, CancelFreightDto, AssignMultiTruckDto, TruckAssignmentDto, RespondTripDto, UpdateAssignmentDto, AddDocumentDto, ConfirmLoadedDto, AddTrackingDto, UpdateFreightDto, ReorderQueueDto, CancelAssignmentDto, ResolvePendingChangeDto, SaveOcrDataDto, MoveAssignmentDto, ReorderAssignmentsDto } from './freights.dto';
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
  constructor(
    private service: FreightsService,
    private suggestions: AssignmentSuggestionsService,
  ) {}

  @Post()
  @Roles('producer', 'plant')
  @ApiOperation({ summary: 'Crear flete (productor o planta)' })
  create(@Body() dto: CreateFreightDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Listar fletes (filtrado por empresa)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'company', required: false, description: 'Filter to a specific company (activeCompanyId)' })
  @ApiQuery({ name: 'search', required: false, description: 'Free-text search across code, grain, origin, destination, transporter, driver, plate' })
  @ApiQuery({ name: 'destName', required: false, description: 'Filter by destination name (contains, case-insensitive)' })
  @ApiQuery({ name: 'originCompany', required: false, description: 'Filter by origin company name (contains, case-insensitive)' })
  @ApiQuery({ name: 'transporter', required: false, description: 'Filter by transporter company name (contains, case-insensitive)' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Filter by load date >= (YYYY-MM-DD)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Filter by load date <= (YYYY-MM-DD)' })
  findAll(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('company') company?: string,
    @Query('search') search?: string,
    @Query('destName') destName?: string,
    @Query('originCompany') originCompany?: string,
    @Query('transporter') transporter?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const parsedPage = page ? Math.min(Math.max(1, parseInt(page) || 1), 200) : undefined;
    const parsedLimit = limit ? Math.min(Math.max(1, parseInt(limit) || 20), 50) : undefined;
    return this.service.findAll(user, {
      status,
      page: Number.isFinite(parsedPage) ? parsedPage : undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      company,
      search: search?.trim() || undefined,
      destName: destName?.trim() || undefined,
      originCompany: originCompany?.trim() || undefined,
      transporter: transporter?.trim() || undefined,
      dateFrom: dateFrom?.trim() || undefined,
      dateTo: dateTo?.trim() || undefined,
    });
  }

  @Get('stats')
  @Roles('producer', 'plant', 'transporter')
  @ApiOperation({ summary: 'Estadísticas de fletes por período' })
  @ApiQuery({ name: 'from', required: false, description: 'Fecha desde (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Fecha hasta (YYYY-MM-DD)' })
  @ApiQuery({ name: 'groupBy', required: false, description: 'day | week | month' })
  getStats(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
  ) {
    return this.service.getStats(user, from?.trim(), to?.trim(), groupBy?.trim() || 'week');
  }

  @Get('drivers')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar choferes disponibles de una empresa' })
  @ApiQuery({ name: 'companyId', required: true })
  getDrivers(@Query('companyId', ParseUUIDPipe) companyId: string, @CurrentUser() user: any) {
    return this.service.getAvailableDrivers(companyId, user);
  }

  @Get('drivers/:driverId/queue')
  @Roles('plant', 'transporter', 'producer')
  @ApiOperation({ summary: 'Cola de fletes de un chofer' })
  getDriverQueue(@Param('driverId', ParseUUIDPipe) driverId: string, @CurrentUser() user: any) {
    return this.service.getDriverQueue(driverId, user);
  }

  @Post('drivers/:driverId/reorder')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Reordenar cola de un chofer (solo planta gerente)' })
  reorderDriverQueue(
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Body() dto: ReorderQueueDto,
    @CurrentUser() user: any,
  ) {
    return this.service.reorderDriverQueue(driverId, dto.orderedFreightIds, user);
  }

  @Get('queue-board')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Tablero de colas de camiones para planta' })
  getQueueBoard(@CurrentUser() user: any) {
    return this.service.getQueueBoard(user);
  }

  @Post('assignments/:assignmentId/move')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Mover assignment a otro flete' })
  moveAssignment(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: MoveAssignmentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.moveAssignment(assignmentId, dto.targetFreightId, user, dto.position);
  }

  @Get('trucks/:truckId/queue')
  @Roles('plant', 'transporter', 'producer')
  @ApiOperation({ summary: 'Cola de fletes de un camión' })
  getTruckQueue(@Param('truckId', ParseUUIDPipe) truckId: string, @CurrentUser() user: any) {
    return this.service.getTruckQueue(truckId, user);
  }

  @Patch('queue-board/reorder')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Reordenar assignments dentro de un flete' })
  reorderAssignments(
    @Body() dto: ReorderAssignmentsDto,
    @CurrentUser() user: any,
  ) {
    return this.service.reorderAssignments(dto.orderedAssignmentIds, user);
  }

  @Get(':id/summary')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Resumen liviano de flete (sin documentos, pendingChanges, historial completo)' })
  findOneSummary(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOneSummary(id);
  }

  @Get(':id/detail-extra')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Solo documentos, conversación y cambios pendientes (complemento del listado)' })
  findOneDetailExtra(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOneDetailExtra(id);
  }

  @Get(':id/assignment-suggestions')
  @UseGuards(FreightAccessGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Roles('plant')
  @ApiOperation({ summary: 'Sugerencias de asignación de transporte' })
  getAssignmentSuggestions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.suggestions.getSuggestions(id, user.sub || user.id);
  }

  @Get(':id')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Detalle de flete' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    // FreightAccessGuard already enforces company-level access; user passed to mark assignments as seen
    return this.service.findOne(id, undefined, user);
  }

  @Post(':id/assign')
  @UseGuards(FreightAccessGuard)
  @Roles('plant', 'producer', 'transporter')
  @ApiOperation({ summary: 'Asignar transportista' })
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
  @Roles('transporter', 'producer', 'plant', 'chofer')
  @ApiOperation({ summary: 'Iniciar viaje' })
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.start(id, user);
  }

  @Post(':id/confirm-loaded')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'producer', 'plant', 'chofer')
  @ApiOperation({ summary: 'Confirmar carga' })
  confirmLoaded(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmLoadedDto, @CurrentUser() user: any) {
    return this.service.confirmLoaded(id, user, dto.loadedTons);
  }

  @Post(':id/confirm-finished')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'producer', 'plant', 'chofer')
  @ApiOperation({ summary: 'Confirmar finalización (requiere ambos: transportista + planta)' })
  confirmFinished(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.confirmFinished(id, user);
  }

  @Post(':id/finish')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'producer', 'plant', 'chofer')
  @ApiOperation({ summary: 'Finalizar viaje — redirige a confirm-finished (cross-confirmation)' })
  finish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.confirmFinished(id, user);
  }

  @Post(':id/cancel')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant')
  @ApiOperation({ summary: 'Cancelar flete (motivo obligatorio)' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelFreightDto,
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(id, dto, user);
  }

  @Post(':id/authorize')
  @UseGuards(FreightAccessGuard)
  @Roles('plant')
  @ApiOperation({ summary: 'Autorizar viaje con flota propia (solo planta)' })
  authorize(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.authorize(id, user);
  }

  @Post(':id/approve-producer')
  @UseGuards(FreightAccessGuard)
  @Roles('plant')
  @ApiOperation({ summary: 'Aprobar flete creado por productor (solo planta)' })
  approveProducer(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.approveProducerFreight(id, user);
  }

  // ======================== MULTI-TRUCK ENDPOINTS (v6.0) ================

  @Post(':id/assign-multi')
  @UseGuards(FreightAccessGuard)
  @Roles('plant', 'producer', 'transporter')
  @ApiOperation({ summary: 'Asignar múltiples camiones a un flete' })
  assignMulti(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignMultiTruckDto,
    @CurrentUser() user: any,
  ) {
    return this.service.assignMulti(id, dto, user);
  }

  @Post(':id/assign-truck')
  @UseGuards(FreightAccessGuard)
  @Roles('plant', 'producer', 'transporter')
  @ApiOperation({ summary: 'Agregar un camión a un flete multi-truck' })
  assignTruck(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TruckAssignmentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.assignTruck(id, dto, user);
  }

  @Post(':id/assignments/:aId/cancel')
  @UseGuards(FreightAccessGuard)
  @Roles('plant')
  @ApiOperation({ summary: 'Cancelar una asignación de camión específica' })
  cancelAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aId', ParseUUIDPipe) aId: string,
    @Body() dto: CancelAssignmentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.cancelAssignment(id, aId, dto.reason, user);
  }

  @Patch(':id/assignments/:aId')
  @UseGuards(FreightAccessGuard)
  @Roles('plant', 'transporter', 'producer')
  @ApiOperation({ summary: 'Editar asignación: planta edita, transportista/productor (flota propia) asigna camión/chofer' })
  updateAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aId', ParseUUIDPipe) aId: string,
    @Body() dto: UpdateAssignmentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateAssignment(id, aId, dto, user);
  }

  @Post(':id/assignments/:aId/respond')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'plant')
  @ApiOperation({ summary: 'Aceptar o rechazar una asignación per-trip' })
  respondTrip(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aId', ParseUUIDPipe) aId: string,
    @Body() dto: RespondTripDto,
    @CurrentUser() user: any,
  ) {
    return this.service.respondTrip(id, aId, dto, user);
  }

  @Post(':id/assignments/:aId/start')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'producer', 'plant', 'chofer')
  @ApiOperation({ summary: 'Iniciar viaje de un camión específico' })
  startTrip(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aId', ParseUUIDPipe) aId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.startTrip(id, aId, user);
  }

  @Post(':id/assignments/:aId/confirm-loaded')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'producer', 'plant', 'chofer')
  @ApiOperation({ summary: 'Confirmar carga de un camión específico' })
  confirmTripLoaded(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aId', ParseUUIDPipe) aId: string,
    @Body() dto: ConfirmLoadedDto,
    @CurrentUser() user: any,
  ) {
    return this.service.confirmTripLoaded(id, aId, user, dto.loadedTons);
  }

  @Post(':id/assignments/:aId/confirm-finished')
  @UseGuards(FreightAccessGuard)
  @Roles('transporter', 'producer', 'plant', 'chofer')
  @ApiOperation({ summary: 'Confirmar entrega de un camión específico' })
  confirmTripFinished(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aId', ParseUUIDPipe) aId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.confirmTripFinished(id, aId, user);
  }

  @Patch(':id')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant')
  @ApiOperation({ summary: 'Editar flete (campos según estado, algunos requieren aprobación)' })
  updateFreight(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFreightDto, @CurrentUser() user: any) {
    return this.service.updateFreight(id, dto, user);
  }

  @Post(':id/pending-changes/:changeId/approve')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant')
  @ApiOperation({ summary: 'Aprobar cambio pendiente de un flete' })
  approvePendingChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Body() dto: ResolvePendingChangeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.approvePendingChange(id, changeId, user);
  }

  @Post(':id/pending-changes/:changeId/reject')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant')
  @ApiOperation({ summary: 'Rechazar cambio pendiente de un flete' })
  rejectPendingChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Body() dto: ResolvePendingChangeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.rejectPendingChange(id, changeId, user, dto.reason);
  }

  @Post(':id/tracking')
  @UseGuards(FreightAccessGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Enviar punto de tracking GPS' })
  addTracking(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddTrackingDto, @CurrentUser() user: any) {
    return this.service.addTrackingPoint(id, dto, user);
  }

  @Get(':id/tracking/participants')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Última posición de cada participante' })
  getParticipantPositions(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getParticipantPositions(id);
  }

  @Get(':id/tracking/last')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Última posición del camión' })
  getLastPosition(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLastPosition(id);
  }

  @Get(':id/tracking')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Obtener puntos de tracking' })
  getTracking(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getTrackingPoints(id);
  }

  @Get(':id/audit')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Historial de cambios del flete' })
  getAuditLog(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getAuditLog(id);
  }

  @Post(':id/documents')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Registrar documento/foto del flete' })
  addDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddDocumentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.addDocument(id, body, user);
  }

  @Patch(':id/documents/:docId/rename')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Renombrar documento del flete' })
  renameDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body('name') name: string,
    @CurrentUser() user: any,
  ) {
    return this.service.renameDocument(id, docId, name, user);
  }

  @Delete(':id/documents/:docId')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @ApiOperation({ summary: 'Eliminar documento/foto del flete' })
  deleteDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.deleteDocument(id, docId, user);
  }

  @Patch(':id/documents/:docId/ocr')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Guardar datos OCR de un documento' })
  saveOcrData(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() dto: SaveOcrDataDto,
    @CurrentUser() user: any,
  ) {
    return this.service.saveOcrData(id, docId, dto.ocrData, user);
  }

  @Patch(':id/documents/:docId/ocr-edit')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Editar manualmente datos OCR de un documento' })
  editOcrData(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() dto: SaveOcrDataDto,
    @CurrentUser() user: any,
  ) {
    return this.service.editOcrData(id, docId, dto.ocrData, user);
  }

  @Patch(':id/documents/:docId/ocr-clear')
  @UseGuards(FreightAccessGuard)
  @Roles('producer', 'plant', 'transporter', 'chofer')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Borrar datos OCR de un documento' })
  clearOcrData(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.clearOcrData(id, docId, user);
  }
}

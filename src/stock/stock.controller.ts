import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CreateStockItemDto,
  CreateStockLocationDto,
  CreateStockMovementDto,
  ListStockItemsQueryDto,
  ListStockLocationsQueryDto,
  ListStockMovementsQueryDto,
  RevertStockMovementDto,
} from './stock.dto';
import { StockService } from './stock.service';

@ApiTags('Stock')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stock')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Get('summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  @ApiOperation({ summary: 'Resumen general de stock/acopio de la empresa activa' })
  getSummary(@CurrentUser() user: any) {
    return this.stockService.getSummary(user);
  }

  @Get('items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  listItems(@CurrentUser() user: any, @Query() query: ListStockItemsQueryDto) {
    return this.stockService.listItems(user, query);
  }

  @Post('items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  createItem(@CurrentUser() user: any, @Body() dto: CreateStockItemDto) {
    return this.stockService.createItem(user, dto);
  }

  @Get('locations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  listLocations(@CurrentUser() user: any, @Query() query: ListStockLocationsQueryDto) {
    return this.stockService.listLocations(user, query);
  }

  @Post('locations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  createLocation(@CurrentUser() user: any, @Body() dto: CreateStockLocationDto) {
    return this.stockService.createLocation(user, dto);
  }

  @Get('movements')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  listMovements(@CurrentUser() user: any, @Query() query: ListStockMovementsQueryDto) {
    return this.stockService.listMovements(user, query);
  }

  @Post('movements')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  createMovement(@CurrentUser() user: any, @Body() dto: CreateStockMovementDto) {
    return this.stockService.createMovement(user, dto);
  }

  @Post('movements/:id/revert')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('producer', 'platform_admin')
  revertMovement(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevertStockMovementDto,
  ) {
    return this.stockService.revertMovement(user, id, dto.reason);
  }
}

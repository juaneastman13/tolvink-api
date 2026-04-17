import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const STOCK_ITEM_CATEGORIES = ['grain', 'fertilizer', 'seed', 'agrochemical', 'fuel', 'other'] as const;
const STOCK_UNITS = ['kg', 'tn', 'lt', 'unit', 'bag'] as const;
const STOCK_LOCATION_TYPES = ['field', 'lot', 'plant', 'warehouse', 'silo', 'silo_bag', 'shed', 'tank', 'other'] as const;
const STOCK_OWNERSHIP_TYPES = ['own', 'third_party'] as const;
const STOCK_MOVEMENT_TYPES = [
  'freight_in_internal',
  'freight_in_third_party',
  'manual_in',
  'purchase_in',
  'adjustment_in',
  'sale_out',
  'reexpedition_out',
  'consumption_out',
  'manual_out',
  'adjustment_out',
  'transfer',
] as const;

export class CreateStockItemDto {
  @ApiProperty({ enum: STOCK_ITEM_CATEGORIES })
  @IsEnum(STOCK_ITEM_CATEGORIES)
  category: (typeof STOCK_ITEM_CATEGORIES)[number];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  code?: string;

  @ApiProperty({ enum: STOCK_UNITS })
  @IsEnum(STOCK_UNITS)
  baseUnit: (typeof STOCK_UNITS)[number];
}

export class ListStockItemsQueryDto {
  @ApiPropertyOptional({ enum: STOCK_ITEM_CATEGORIES })
  @IsOptional()
  @IsEnum(STOCK_ITEM_CATEGORIES)
  category?: (typeof STOCK_ITEM_CATEGORIES)[number];
}

export class CreateStockLocationDto {
  @ApiProperty({ enum: STOCK_LOCATION_TYPES })
  @IsEnum(STOCK_LOCATION_TYPES)
  locationType: (typeof STOCK_LOCATION_TYPES)[number];

  @ApiProperty({ enum: STOCK_OWNERSHIP_TYPES })
  @IsEnum(STOCK_OWNERSHIP_TYPES)
  ownershipType: (typeof STOCK_OWNERSHIP_TYPES)[number];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  lotId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  plantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class ListStockLocationsQueryDto {
  @ApiPropertyOptional({ enum: STOCK_LOCATION_TYPES })
  @IsOptional()
  @IsEnum(STOCK_LOCATION_TYPES)
  locationType?: (typeof STOCK_LOCATION_TYPES)[number];

  @ApiPropertyOptional({ enum: STOCK_OWNERSHIP_TYPES })
  @IsOptional()
  @IsEnum(STOCK_OWNERSHIP_TYPES)
  ownershipType?: (typeof STOCK_OWNERSHIP_TYPES)[number];
}

export class CreateStockMovementDto {
  @ApiProperty({ enum: STOCK_MOVEMENT_TYPES })
  @IsEnum(STOCK_MOVEMENT_TYPES)
  movementType: (typeof STOCK_MOVEMENT_TYPES)[number];

  @ApiProperty()
  @IsUUID()
  itemId: string;

  @ApiProperty({ example: 30000 })
  @IsNumber()
  @Min(0.001)
  @Type(() => Number)
  quantity: number;

  @ApiProperty({ enum: STOCK_UNITS })
  @IsEnum(STOCK_UNITS)
  unit: (typeof STOCK_UNITS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  fromLocationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  toLocationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class ListStockMovementsQueryDto {
  @ApiPropertyOptional({ enum: STOCK_ITEM_CATEGORIES })
  @IsOptional()
  @IsEnum(STOCK_ITEM_CATEGORIES)
  category?: (typeof STOCK_ITEM_CATEGORIES)[number];

  @ApiPropertyOptional({ enum: STOCK_MOVEMENT_TYPES })
  @IsOptional()
  @IsEnum(STOCK_MOVEMENT_TYPES)
  movementType?: (typeof STOCK_MOVEMENT_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class RevertStockMovementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string;
}

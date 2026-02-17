import { IsNotEmpty, IsEnum, IsUUID, IsOptional, IsArray, ValidateNested, IsNumber, Min, Max, MaxLength, IsDateString, Matches, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class FreightItemDto {
  @ApiProperty({ enum: ['Soja', 'Maiz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'] })
  @IsEnum(['Soja', 'Maiz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'])
  grain: string;

  @ApiProperty({ example: 30, description: 'Cantidad (toneladas por defecto)' })
  @IsNumber()
  @Min(0.1, { message: 'Cantidad debe ser mayor a 0' })
  @Type(() => Number)
  tons: number;

  @ApiProperty({ required: false, enum: ['toneladas', 'cantidad', 'metros', 'm3'], default: 'toneladas' })
  @IsOptional()
  @IsEnum(['toneladas', 'cantidad', 'metros', 'm3'])
  unit?: string;

  @ApiProperty({ required: false, description: 'Importe' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount?: number;

  @ApiProperty({ required: false, description: 'Descripción si tipo = Otros' })
  @ValidateIf(o => o.grain === 'Otros')
  @IsNotEmpty({ message: 'Descripción obligatoria si tipo es Otros' })
  @MaxLength(255)
  productTypeOther?: string;

  @IsOptional()
  notes?: string;
}

export class CreateFreightDto {
  @ApiProperty({ required: false, description: 'ID del lote de origen (opcional si se indica ubicación en mapa)' })
  @IsOptional()
  @IsUUID()
  originLotId?: string;

  @ApiProperty({ required: false, description: 'Nombre del origen personalizado (cuando no se selecciona lote)' })
  @IsOptional()
  @MaxLength(255)
  customOriginName?: string;

  @ApiProperty({ required: false, description: 'ID del campo' })
  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  destPlantId?: string;

  @ApiProperty({ required: false, description: 'ID de empresa destino (para destinos custom vinculados)' })
  @IsOptional()
  @IsUUID()
  destCompanyId?: string;

  @ApiProperty({ required: false, description: 'Nombre del destino personalizado' })
  @IsOptional()
  @MaxLength(255)
  customDestName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  @Type(() => Number)
  customDestLat?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  @Type(() => Number)
  customDestLng?: number;

  @ApiProperty({ example: '2026-02-20' })
  @IsDateString()
  loadDate: string;

  @ApiProperty({ example: '08:00' })
  @Matches(/^\d{2}:\d{2}$/, { message: 'Formato de hora inválido (HH:MM)' })
  loadTime: string;

  @ApiProperty({ type: [FreightItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FreightItemDto)
  items: FreightItemDto[];

  @IsOptional()
  @MaxLength(1000)
  notes?: string;

  @ApiProperty({ required: false, description: 'ID del camión (flota propia del productor)' })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  @Type(() => Number)
  overrideOriginLat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  @Type(() => Number)
  overrideOriginLng?: number;

  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  @Type(() => Number)
  overrideDestLat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  @Type(() => Number)
  overrideDestLng?: number;
}

export class AssignFreightDto {
  @ApiProperty({ description: 'ID de empresa transportista' })
  @IsUUID()
  transportCompanyId: string;
}

export class RespondAssignmentDto {
  @ApiProperty({ enum: ['accepted', 'rejected'] })
  @IsEnum(['accepted', 'rejected'])
  action: 'accepted' | 'rejected';

  @ApiProperty({ required: false, description: 'Motivo (obligatorio si rechaza)', maxLength: 255 })
  @IsOptional()
  @MaxLength(255)
  reason?: string;

  @ApiProperty({ required: false, description: 'ID del camión (obligatorio si acepta)' })
  @IsOptional()
  @IsUUID()
  truckId?: string;
}

export class CancelFreightDto {
  @ApiProperty({ description: 'Motivo de cancelación', maxLength: 255 })
  @IsNotEmpty({ message: 'Motivo obligatorio' })
  @MaxLength(255)
  reason: string;
}

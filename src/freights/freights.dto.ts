import { IsNotEmpty, IsEnum, IsUUID, IsOptional, IsArray, ValidateNested, IsNumber, Min, MaxLength, IsDateString, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class FreightItemDto {
  @ApiProperty({ enum: ['Soja', 'Maiz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada'] })
  @IsEnum(['Soja', 'Maiz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada'])
  grain: string;

  @ApiProperty({ example: 30 })
  @IsNumber()
  @Min(0.1, { message: 'Toneladas debe ser mayor a 0' })
  tons: number;

  @IsOptional()
  notes?: string;
}

export class CreateFreightDto {
  @ApiProperty()
  @IsUUID()
  originLotId: string;

  @ApiProperty()
  @IsUUID()
  destPlantId: string;

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

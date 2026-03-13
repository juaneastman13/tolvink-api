import { IsOptional, IsUUID, IsString, IsNumber, IsUrl, IsIn, MaxLength, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export const TICKET_TYPES = ['origin', 'destination'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export class CreateWeighTicketDto {
  @ApiProperty({ required: false, enum: TICKET_TYPES, default: 'destination' })
  @IsOptional()
  @IsIn(TICKET_TYPES)
  type?: TicketType;

  @ApiProperty({ required: false, description: 'ID de la asignación (para multi-truck)' })
  @IsOptional()
  @IsUUID()
  assignmentId?: string;

  @ApiProperty({ required: false, description: 'Número impreso en el ticket de balanza' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ticketNumber?: string;

  @ApiProperty({ required: false, description: 'Peso bruto en kg' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  grossWeight?: number;

  @ApiProperty({ required: false, description: 'Tara en kg' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  tareWeight?: number;

  @ApiProperty({ required: false, description: 'Peso neto en kg (calculado si no se envía)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  netWeight?: number;

  @ApiProperty({ required: false, description: 'Humedad (%)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  humidity?: number;

  @ApiProperty({ required: false, description: 'Impurezas (%)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  impurities?: number;

  @ApiProperty({ required: false, description: 'Merma/descuento en kg o %' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  dockage?: number;

  @ApiProperty({ required: false, description: 'Temperatura del grano (°C)' })
  @IsOptional()
  @IsNumber()
  @Min(-50)
  @Max(100)
  @Type(() => Number)
  temperature?: number;

  @ApiProperty({ required: false, description: 'Observaciones del balancero' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observations?: string;

  @ApiProperty({ required: false, description: 'URL de la foto del ticket (Supabase Storage)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  photoUrl?: string;
}

export class UpdateWeighTicketDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ticketNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  grossWeight?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  tareWeight?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  netWeight?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  humidity?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  impurities?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(200000)
  @Type(() => Number)
  dockage?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(-50)
  @Max(100)
  @Type(() => Number)
  temperature?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observations?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  photoUrl?: string;
}

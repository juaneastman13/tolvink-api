import { IsNotEmpty, IsEnum, IsUUID, IsOptional, IsArray, ArrayMinSize, ArrayMaxSize, ValidateNested, IsNumber, IsBoolean, IsString, IsObject, Min, Max, MaxLength, IsDateString, Matches, ValidateIf, IsUrl, IsIn, ValidatorConstraint, ValidatorConstraintInterface, Validate } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

@ValidatorConstraint({ name: 'maxJsonSize', async: false })
class MaxJsonSize50KB implements ValidatorConstraintInterface {
  validate(value: any) {
    if (!value) return true;
    try { return JSON.stringify(value).length <= 51200; } catch { return false; }
  }
  defaultMessage() { return 'JSON data must be under 50KB'; }
}

export class FreightItemDto {
  // Previously strict enum — now accepts any string from the company's product catalog.
  // Backward compatible: old enum values (Soja, Maíz, etc.) remain valid strings.
  @ApiProperty({ description: 'Nombre del producto (libre o del catálogo de la empresa)' })
  @IsString()
  @IsNotEmpty({ message: 'El producto es obligatorio' })
  @MaxLength(100, { message: 'Nombre de producto máximo 100 caracteres' })
  grain: string;

  @ApiProperty({ required: false, description: 'ID del producto del catálogo de la empresa (nullable)' })
  @IsOptional()
  @IsUUID()
  companyProductId?: string;

  @ApiProperty({ example: 30, description: 'Cantidad (toneladas por defecto)', required: false })
  @IsOptional()
  @IsNumber()
  @Min(0.1, { message: 'Cantidad debe ser mayor a 0' })
  @Max(100000)
  @Type(() => Number)
  tons?: number;

  @ApiProperty({ required: false, enum: ['toneladas', 'kg', 'cantidad', 'metros', 'm3'], default: 'toneladas' })
  @IsOptional()
  @IsEnum(['toneladas', 'kg', 'cantidad', 'metros', 'm3'])
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
  @IsString()
  @MaxLength(1000)
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

  @ApiProperty({ required: false, description: 'ID de planta Tolvink del directorio maestro' })
  @IsOptional()
  @IsUUID()
  tolvinkPlantId?: string;

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
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'Formato de hora inválido (HH:MM, 00:00-23:59)' })
  loadTime: string;

  @ApiProperty({ type: [FreightItemDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Debe incluir al menos un producto' })
  @ArrayMaxSize(20, { message: 'Máximo 20 productos por flete' })
  @ValidateNested({ each: true })
  @Type(() => FreightItemDto)
  items: FreightItemDto[];

  @IsOptional()
  @MaxLength(1000)
  notes?: string;

  @ApiProperty({ required: false, description: 'Cantidad de camiones necesarios', minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  truckCount?: number;

  @ApiProperty({ required: false, description: 'ID del camión (flota propia del productor)' })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @ApiProperty({ required: false, description: 'ID del chofer asignado (flota propia)' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiProperty({ required: false, description: 'Decisión explícita: true=flota propia, false=delegar a planta' })
  @IsOptional()
  @IsBoolean()
  useOwnFleet?: boolean;

  @ApiProperty({ required: false, description: 'ID empresa productora (cuando planta crea flete en nombre de productor)' })
  @IsOptional()
  @IsUUID()
  producerCompanyId?: string;

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
  @ApiProperty({ description: 'ID de empresa transportista (requerido si no es externo)' })
  @IsOptional()
  @IsUUID()
  transportCompanyId?: string;

  @ApiProperty({ required: false, description: 'ID del camión (flota propia)' })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @ApiProperty({ required: false, description: 'ID del chofer asignado' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiProperty({ required: false, description: 'Camión de terceros (no registrado en sistema)', default: false })
  @IsOptional()
  @IsBoolean()
  isExternal?: boolean;

  @ApiProperty({ required: false, description: 'Matrícula del camión externo', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;

  @ApiProperty({ required: false, description: 'Nombre empresa transportista externa', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalCompanyName?: string;

  @ApiProperty({ required: false, description: 'Nombre del chofer externo', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalDriverName?: string;
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

  @ApiProperty({ required: false, description: 'ID del chofer asignado' })
  @IsOptional()
  @IsUUID()
  driverId?: string;
}

export class CancelFreightDto {
  @ApiProperty({ description: 'Motivo de cancelación', maxLength: 255 })
  @IsNotEmpty({ message: 'Motivo obligatorio' })
  @MaxLength(255)
  reason: string;
}

// ======================== AUTONOMOUS FREIGHT DTO =========================

export class CreateAutonomousFreightDto {
  @ApiProperty({ required: false, description: 'Nombre de origen (campo/lote o texto libre)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  origin?: string;

  @ApiProperty({ description: 'Nombre de destino (planta o texto libre)' })
  @IsNotEmpty({ message: 'Destino obligatorio' })
  @IsString()
  @MaxLength(255)
  destination: string;

  @ApiProperty({ description: 'Grano/cultivo (texto libre, se normaliza)' })
  @IsNotEmpty({ message: 'Grano obligatorio' })
  @IsString()
  @MaxLength(100)
  grain: string;

  @ApiProperty({ required: false, description: 'Peso en kg' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  weightKg?: number;

  @ApiProperty({ required: false, description: 'ID del camión del chofer (auto-detectar si tiene uno solo)' })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiProperty({ required: false, description: 'ID del campo de origen (si se resolvió)' })
  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @ApiProperty({ required: false, description: 'ID del lote de origen (si se resolvió)' })
  @IsOptional()
  @IsUUID()
  originLotId?: string;

  @ApiProperty({ required: false, description: 'ID de planta destino (si se resolvió)' })
  @IsOptional()
  @IsUUID()
  destPlantId?: string;

  @ApiProperty({ required: false, description: 'ID de planta Tolvink del directorio maestro (si se resolvio)' })
  @IsOptional()
  @IsUUID()
  tolvinkPlantId?: string;

  @ApiProperty({ required: false, description: 'ID de sucursal destino' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

// ======================== MULTI-TRUCK DTOs ==============================

export class TruckAssignmentDto {
  @ApiProperty({ description: 'ID de empresa transportista (requerido si no es externo)' })
  @IsOptional()
  @IsUUID()
  transportCompanyId?: string;

  @ApiProperty({ required: false, description: 'ID del camión' })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @ApiProperty({ required: false, description: 'ID del chofer' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiProperty({ required: false, description: 'Toneladas para este camión' })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100000)
  @Type(() => Number)
  tons?: number;

  @ApiProperty({ required: false, description: 'Camión de terceros', default: false })
  @IsOptional()
  @IsBoolean()
  isExternal?: boolean;

  @ApiProperty({ required: false, description: 'Matrícula del camión externo', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;

  @ApiProperty({ required: false, description: 'Nombre empresa transportista externa', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalCompanyName?: string;

  @ApiProperty({ required: false, description: 'Nombre del chofer externo', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalDriverName?: string;
}

export class AssignMultiTruckDto {
  @ApiProperty({ type: [TruckAssignmentDto], description: 'Lista de camiones a asignar' })
  @IsArray()
  @ArrayMinSize(1, { message: 'Debe incluir al menos un camión' })
  @ArrayMaxSize(50, { message: 'Máximo 50 camiones por asignación' })
  @ValidateNested({ each: true })
  @Type(() => TruckAssignmentDto)
  trucks: TruckAssignmentDto[];
}

export class UpdateAssignmentDto {
  @ApiProperty({ required: false, description: 'ID de empresa transportista' })
  @IsOptional()
  @IsUUID()
  transportCompanyId?: string;

  @ApiProperty({ required: false, description: 'ID del camión' })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @ApiProperty({ required: false, description: 'ID del chofer' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiProperty({ required: false, description: 'Toneladas para este camión' })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100000)
  @Type(() => Number)
  tons?: number;

  @ApiProperty({ required: false, description: 'Matrícula (para camión externo)', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;

  @ApiProperty({ required: false, description: 'Nombre empresa externa', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalCompanyName?: string;

  @ApiProperty({ required: false, description: 'Nombre chofer externo', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalDriverName?: string;
}

export class AddDocumentDto {
  @ApiProperty({ maxLength: 255 })
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ maxLength: 500 })
  @IsNotEmpty()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  url: string;

  @ApiProperty({ required: false, maxLength: 50 })
  @IsOptional()
  @IsIn(['photo', 'pdf', 'remito', 'carta_porte', 'pesaje', 'other'])
  type?: string;

  @ApiProperty({ required: false, maxLength: 50 })
  @IsOptional()
  @IsIn(['request', 'assignment', 'load_confirmation', 'delivery_confirmation', 'cancellation'])
  step?: string;
}

export class ConfirmLoadedDto {
  @ApiProperty({ required: false, description: 'Toneladas cargadas' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  @Type(() => Number)
  loadedTons?: number;
}

export class AddTrackingDto {
  @ApiProperty({ description: 'Latitud (-90 a 90)' })
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  lat: number;

  @ApiProperty({ description: 'Longitud (-180 a 180)' })
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  lng: number;

  @ApiProperty({ required: false, description: 'Velocidad km/h' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  @Type(() => Number)
  speed?: number;

  @ApiProperty({ required: false, description: 'Rumbo en grados (0-360)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  @Type(() => Number)
  heading?: number;
}

export class UpdateFreightDto {
  @ApiProperty({ required: false, description: 'Fecha de carga (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  loadDate?: string;

  @ApiProperty({ required: false, description: 'Hora de carga (HH:MM)' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'loadTime debe ser HH:MM (00:00-23:59)' })
  loadTime?: string;

  @ApiProperty({ required: false, description: 'Notas', maxLength: 2000 })
  @IsOptional()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({ required: false, description: 'Cantidad de camiones necesarios', minimum: 1, maximum: 50 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  truckCount?: number;

  @ApiProperty({ required: false, description: 'Flota propia (true/false)' })
  @IsOptional()
  @IsBoolean()
  useOwnFleet?: boolean;

  @ApiProperty({ required: false, description: 'ID de planta destino' })
  @IsOptional()
  @IsUUID()
  destPlantId?: string;

  @ApiProperty({ required: false, description: 'ID de camión (flota propia)' })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @ApiProperty({ required: false, description: 'ID de chofer (flota propia)' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiProperty({ required: false, description: 'Nombre de sucursal destino' })
  @IsOptional()
  @MaxLength(255)
  customDestName?: string;

  @ApiProperty({ required: false, description: 'Latitud de sucursal destino' })
  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  @Type(() => Number)
  customDestLat?: number;

  @ApiProperty({ required: false, description: 'Longitud de sucursal destino' })
  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  @Type(() => Number)
  customDestLng?: number;
}

export class ResolvePendingChangeDto {
  @ApiProperty({ required: false, description: 'Motivo', maxLength: 255 })
  @IsOptional()
  @MaxLength(255)
  reason?: string;
}

export class ReorderQueueDto {
  @ApiProperty({ description: 'IDs de fletes ordenados' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  orderedFreightIds: string[];
}

export class MoveAssignmentDto {
  @ApiProperty({ description: 'ID del flete destino' })
  @IsUUID()
  targetFreightId: string;

  @ApiProperty({ required: false, description: 'Posición en cola destino' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  position?: number;
}

export class ReorderAssignmentsDto {
  @ApiProperty({ description: 'IDs de assignments en nuevo orden' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  orderedAssignmentIds: string[];
}

export class CancelAssignmentDto {
  @ApiProperty({ description: 'Motivo de cancelación', maxLength: 500 })
  @IsNotEmpty({ message: 'Motivo obligatorio' })
  @MaxLength(500)
  reason: string;
}

export class SaveOcrDataDto {
  @IsNotEmpty()
  @IsObject()
  @Validate(MaxJsonSize50KB)
  ocrData: Record<string, any>;
}

export class RespondTripDto {
  @ApiProperty({ enum: ['accepted', 'rejected'] })
  @IsEnum(['accepted', 'rejected'])
  action: 'accepted' | 'rejected';

  @ApiProperty({ required: false, maxLength: 255 })
  @IsOptional()
  @MaxLength(255)
  reason?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  truckId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  driverId?: string;
}

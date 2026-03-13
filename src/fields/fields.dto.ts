import { IsString, IsOptional, IsNumber, IsArray, ValidateNested, ArrayMaxSize, MinLength, Min, Max, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateFieldDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  lng?: number;
}

export class UpdateFieldDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  lng?: number;
}

export class CreateLotDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  hectares?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  lng?: number;
}

export class UpdateLotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  hectares?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  lng?: number;
}

// ── Import from Google Maps links ──────────────────────────────────

export class ImportParseLinksDto {
  @ApiProperty({ description: 'Texto pegado con links de Google Maps' })
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  text: string;
}

export class ImportLocationDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiProperty()
  @IsNumber()
  @Min(-90) @Max(90)
  lat: number;

  @ApiProperty()
  @IsNumber()
  @Min(-180) @Max(180)
  lng: number;
}

export class ImportConfirmDto {
  @ApiProperty({ type: [ImportLocationDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ImportLocationDto)
  locations: ImportLocationDto[];
}

// ── Points of Interest ────────────────────────────────────────────

export class CreatePoiDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiProperty()
  @IsNumber()
  @Min(-90) @Max(90)
  lat: number;

  @ApiProperty()
  @IsNumber()
  @Min(-180) @Max(180)
  lng: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comments?: string;
}

export class UpdatePoiDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-90) @Max(90)
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-180) @Max(180)
  lng?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comments?: string;
}

export class ImportGoogleListDto {
  @ApiProperty({ description: 'URL de lista compartida de Google Maps' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  url: string;
}

// ── Shared POIs ──────────────────────────────────────────────────────

export class SharePoiDto {
  @ApiProperty({ description: 'ID del usuario con quien compartir' })
  @IsString()
  @MinLength(1)
  sharedWithUserId: string;
}

export class UnsharePoiDto {
  @ApiProperty({ description: 'ID del usuario a dejar de compartir' })
  @IsString()
  @MinLength(1)
  sharedWithUserId: string;
}

// ── Shared Fields ─────────────────────────────────────────────────────

export class ShareFieldDto {
  @ApiProperty({ description: 'ID del usuario con quien compartir' })
  @IsString()
  @MinLength(1)
  sharedWithUserId: string;
}

export class UnshareFieldDto {
  @ApiProperty({ description: 'ID del usuario a dejar de compartir' })
  @IsString()
  @MinLength(1)
  sharedWithUserId: string;
}

// ── Shared Lots ───────────────────────────────────────────────────────

export class ShareLotDto {
  @ApiProperty({ description: 'ID del usuario con quien compartir' })
  @IsString()
  @MinLength(1)
  sharedWithUserId: string;
}

export class UnshareLotDto {
  @ApiProperty({ description: 'ID del usuario a dejar de compartir' })
  @IsString()
  @MinLength(1)
  sharedWithUserId: string;
}

// ── Reclassify POI ───────────────────────────────────────────────────

export class ReclassifyPoiDto {
  @ApiProperty({ description: 'Nuevo tipo: field o lot', enum: ['field', 'lot'] })
  @IsString()
  targetType: 'field' | 'lot';

  @ApiPropertyOptional({ description: 'ID del campo padre (requerido si targetType=lot)' })
  @IsOptional()
  @IsString()
  fieldId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  hectares?: number;
}

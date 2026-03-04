import { IsString, IsOptional, IsNumber, MinLength, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFieldDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
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
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
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

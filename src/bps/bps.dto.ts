import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const BPS_FRECUENCIAS = ['diaria', 'semanal', 'quincenal'] as const;

export class ConsultarCertificadoDto {
  @ApiProperty({ description: 'RUT uruguayo de 12 dígitos' })
  @IsString()
  @Matches(/^\d{12}$/, { message: 'El RUT debe tener 12 dígitos' })
  rut: string;
}

export class MonitorearEmpresaDto {
  @ApiProperty({ description: 'RUT uruguayo de 12 dígitos' })
  @IsString()
  @Matches(/^\d{12}$/, { message: 'El RUT debe tener 12 dígitos' })
  rut: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nombre?: string;

  @ApiPropertyOptional({ description: 'Empresa Tolvink vinculada' })
  @IsOptional()
  @IsUUID()
  linkedCompanyId?: string;
}

export class UpdateBpsConfigDto {
  @ApiPropertyOptional({ enum: BPS_FRECUENCIAS })
  @IsOptional()
  @IsEnum(BPS_FRECUENCIAS)
  frecuencia?: (typeof BPS_FRECUENCIAS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  alertasActivas?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  notificarDiasAntes?: number;
}

export class ConectarCuentaDto {
  @ApiProperty({ description: 'Usuario BPS directo (no ID Uruguay)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  usuario: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;
}

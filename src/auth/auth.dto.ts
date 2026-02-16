import { IsEmail, IsNotEmpty, MinLength, MaxLength, IsEnum, IsOptional, IsArray, ArrayMinSize, Matches, IsString, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'carolina@planta.com', required: false })
  @ValidateIf(o => !o.phone)
  @IsEmail({}, { message: 'Email inválido' })
  email?: string;

  @ApiProperty({ example: '091234567', required: false })
  @ValidateIf(o => !o.email)
  @Matches(/^09[1-9]\d{6}$/, { message: 'Teléfono inválido. Formato: 09XXXXXXX' })
  phone?: string;

  @ApiProperty({ example: '1234' })
  @IsNotEmpty({ message: 'Contraseña requerida' })
  @MinLength(4, { message: 'Mínimo 4 caracteres' })
  password: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'Juan Pérez' })
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'juan@campo.com' })
  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @ApiProperty({ example: '091234567' })
  @IsNotEmpty({ message: 'Teléfono requerido' })
  @Matches(/^09[1-9]\d{6}$/, { message: 'Teléfono inválido. Formato: 09XXXXXXX' })
  phone: string;

  @ApiProperty({ example: 'securepass' })
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: ['producer'], enum: ['producer', 'plant', 'transporter'], isArray: true })
  @IsArray({ message: 'userTypes debe ser un array' })
  @ArrayMinSize(1, { message: 'Seleccioná al menos un tipo de usuario' })
  @IsEnum(['producer', 'plant', 'transporter'], { each: true, message: 'Tipo inválido' })
  userTypes: string[];
}

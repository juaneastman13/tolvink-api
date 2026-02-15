import { IsEmail, IsNotEmpty, MinLength, MaxLength, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'carolina@planta.com' })
  @IsEmail({}, { message: 'Email inválido' })
  email: string;

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

  @ApiProperty({ example: 'securepass' })
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(128)
  password: string;

  @ApiProperty({ enum: ['producer', 'plant', 'transporter'] })
  @IsEnum(['producer', 'plant', 'transporter'], { message: 'Tipo inválido' })
  companyType: string;

  @ApiProperty({ example: 'Est. Las Acacias' })
  @IsNotEmpty()
  @MinLength(2)
  companyName: string;

  @ApiProperty({ enum: ['admin', 'operator'], required: false })
  @IsOptional()
  @IsEnum(['admin', 'operator'])
  role?: string;
}

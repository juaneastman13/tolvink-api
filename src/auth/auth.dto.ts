import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, IsArray, ArrayMinSize, Matches, ValidateIf } from 'class-validator';

export class LoginDto {
  @ValidateIf(o => !o.phone)
  @IsEmail({}, { message: 'Email invalido' })
  email?: string;

  @ValidateIf(o => !o.email)
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  password?: string;
}

export class RegisterDto {
  @IsNotEmpty({ message: 'Nombre requerido' })
  @IsString()
  @MinLength(2, { message: 'Nombre muy corto' })
  name: string;

  @IsEmail({}, { message: 'Email invalido' })
  email: string;

  @IsNotEmpty({ message: 'Telefono requerido' })
  @IsString()
  @Matches(/^09[1-9]\d{6}$/, { message: 'Formato: 09XXXXXXX (9 digitos)' })
  phone: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsArray({ message: 'userTypes debe ser un array' })
  @ArrayMinSize(1, { message: 'Selecciona al menos un tipo' })
  @IsString({ each: true })
  userTypes: string[];
}

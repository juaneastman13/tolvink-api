import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, IsArray, ArrayMinSize, Matches, ValidateIf } from 'class-validator';

export class LoginDto {
  @ValidateIf(o => !o.phone)
  @IsEmail({}, { message: 'Email inválido' })
  email?: string;

  @ValidateIf(o => !o.email)
  @IsString()
  @Matches(/^09[1-9]\d{6}$/, { message: 'Formato de teléfono inválido' })
  phone?: string;

  @IsOptional()
  @IsString()
  password?: string;
}

export class SwitchCompanyDto {
  @IsNotEmpty({ message: 'companyId requerido' })
  @IsString()
  companyId: string;
}

export class RegisterDto {
  @IsNotEmpty({ message: 'Nombre requerido' })
  @IsString()
  @MinLength(2, { message: 'Nombre muy corto' })
  name: string;

  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @IsNotEmpty({ message: 'Teléfono requerido' })
  @IsString()
  @Matches(/^09[1-9]\d{6}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' })
  phone: string;

  @IsNotEmpty({ message: 'Contraseña requerida' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número' })
  password: string;

  @IsArray({ message: 'userTypes debe ser un array' })
  @ArrayMinSize(1, { message: 'Seleccioná al menos un tipo' })
  @IsString({ each: true })
  userTypes: string[];
}

export class RefreshTokenDto {
  @IsNotEmpty({ message: 'refreshToken requerido' })
  @IsString()
  refreshToken: string;
}

export class IdentifyForResetDto {
  @IsNotEmpty({ message: 'Email o teléfono requerido' })
  @IsString()
  identifier: string;
}

export class RequestCodeDto {
  @IsNotEmpty({ message: 'Identificador requerido' })
  @IsString()
  identifier: string;

  @IsNotEmpty({ message: 'Teléfono requerido' })
  @IsString()
  @Matches(/^09[1-9]\d{6}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' })
  phone: string;
}

export class VerifyCodeDto {
  @IsNotEmpty({ message: 'Teléfono requerido' })
  @IsString()
  @Matches(/^09[1-9]\d{6}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' })
  phone: string;

  @IsNotEmpty({ message: 'Código requerido' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos numéricos' })
  code: string;
}

export class ResetPasswordDto {
  @IsNotEmpty({ message: 'Token requerido' })
  @IsString()
  resetToken: string;

  @IsNotEmpty({ message: 'Contraseña requerida' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número' })
  newPassword: string;
}

export class ChangePasswordDto {
  @IsNotEmpty({ message: 'Contraseña actual requerida' })
  @IsString()
  currentPassword: string;

  @IsNotEmpty({ message: 'Nueva contraseña requerida' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número' })
  newPassword: string;
}

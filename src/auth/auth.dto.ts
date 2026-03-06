import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, MaxLength, IsArray, ArrayMinSize, Matches, ValidateIf, IsIn, IsUUID } from 'class-validator';

export class LoginDto {
  @ValidateIf(o => !o.phone)
  @IsEmail({}, { message: 'Email inválido' })
  email?: string;

  @ValidateIf(o => !o.email)
  @IsString()
  @Matches(/^09\d{7}$/, { message: 'Formato de teléfono inválido' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}

export class SwitchCompanyDto {
  @IsNotEmpty({ message: 'companyId requerido' })
  @IsString()
  @IsUUID('4', { message: 'companyId debe ser un UUID válido' })
  companyId: string;
}

export class RegisterDto {
  @IsNotEmpty({ message: 'Nombre requerido' })
  @IsString()
  @MinLength(2, { message: 'Nombre muy corto' })
  @MaxLength(255)
  name: string;

  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @IsNotEmpty({ message: 'Teléfono requerido' })
  @IsString()
  @Matches(/^09\d{7}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' })
  phone: string;

  @IsNotEmpty({ message: 'Contraseña requerida' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número' })
  password: string;

  @IsArray({ message: 'userTypes debe ser un array' })
  @ArrayMinSize(1, { message: 'Seleccioná al menos un tipo' })
  @IsIn(['producer', 'plant', 'transporter'], { each: true, message: 'Tipo inválido. Valores permitidos: producer, plant, transporter' })
  userTypes: string[];
}

export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  refreshToken?: string;
}

export class IdentifyForResetDto {
  @IsNotEmpty({ message: 'Email o teléfono requerido' })
  @IsString()
  @MaxLength(500)
  identifier: string;
}

export class RequestCodeDto {
  @IsNotEmpty({ message: 'Identificador requerido' })
  @IsString()
  @MaxLength(500)
  identifier: string;

  @IsNotEmpty({ message: 'Teléfono requerido' })
  @IsString()
  @Matches(/^09\d{7}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' })
  phone: string;
}

export class VerifyCodeDto {
  @IsNotEmpty({ message: 'Teléfono requerido' })
  @IsString()
  @Matches(/^09\d{7}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' })
  phone: string;

  @IsNotEmpty({ message: 'Código requerido' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos numéricos' })
  code: string;
}

export class ResetPasswordDto {
  @IsNotEmpty({ message: 'Token requerido' })
  @IsString()
  @MaxLength(500)
  resetToken: string;

  @IsNotEmpty({ message: 'Contraseña requerida' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número' })
  newPassword: string;
}

export class ChangePasswordDto {
  @IsNotEmpty({ message: 'Contraseña actual requerida' })
  @IsString()
  @MaxLength(128)
  currentPassword: string;

  @IsNotEmpty({ message: 'Nueva contraseña requerida' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número' })
  newPassword: string;
}

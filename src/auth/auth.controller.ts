import { Controller, Post, Patch, Body, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, SwitchCompanyDto, RefreshTokenDto, IdentifyForResetDto, RequestCodeDto, VerifyCodeDto, ResetPasswordDto, ChangePasswordDto } from './auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('ping')
  @SkipThrottle()
  @ApiOperation({ summary: 'Simple ping endpoint' })
  ping() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Post('login')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Login con email o teléfono + contraseña' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('register')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Registrar usuario' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('identify-for-reset')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Identificar usuario para reset — devuelve teléfono enmascarado' })
  identifyForReset(@Body() dto: IdentifyForResetDto) {
    return this.authService.identifyForReset(dto);
  }

  @Post('request-code')
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({ summary: 'Solicitar código de verificación por WhatsApp (requiere confirmar teléfono)' })
  requestCode(@Body() dto: RequestCodeDto) {
    return this.authService.requestCode(dto);
  }

  @Post('verify-code')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Verificar código de WhatsApp' })
  verifyCode(@Body() dto: VerifyCodeDto) {
    return this.authService.verifyCode(dto);
  }

  @Post('reset-password')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Establecer nueva contraseña con token de reset' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('refresh')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Renovar token de acceso' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cerrar sesión (revocar refresh tokens)' })
  logout(@CurrentUser() user: any) {
    return this.authService.revokeRefreshTokens(user.sub);
  }

  @Post('switch-company')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambiar empresa activa' })
  switchCompany(@Body() dto: SwitchCompanyDto, @CurrentUser() user: any) {
    return this.authService.switchCompany(user.sub, dto);
  }

  @Patch('password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({ summary: 'Cambiar contraseña (autenticado)' })
  changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: any) {
    return this.authService.changePassword(user.sub, dto);
  }

  @Get('me/companies')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Listar mis empresas' })
  myCompanies(@CurrentUser() user: any) {
    return this.authService.getMyCompanies(user.sub);
  }

  @Patch('me/onboarding-complete')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Marcar onboarding como completado' })
  completeOnboarding(@CurrentUser() user: any) {
    return this.authService.completeOnboarding(user.sub);
  }
}

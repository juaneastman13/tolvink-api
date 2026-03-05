import { Controller, Post, Patch, Body, Get, UseGuards, Res, Req, UnauthorizedException } from '@nestjs/common';
import { Response, Request } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, SwitchCompanyDto, RefreshTokenDto, IdentifyForResetDto, RequestCodeDto, VerifyCodeDto, ResetPasswordDto, ChangePasswordDto } from './auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

const COOKIE_OPTS: any = { httpOnly: true, secure: true, sameSite: 'none', partitioned: true };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('accessToken', accessToken, { ...COOKIE_OPTS, path: '/api', maxAge: 30 * 60 * 1000 });
    res.cookie('refreshToken', refreshToken, { ...COOKIE_OPTS, path: '/api/auth', maxAge: 7 * 24 * 60 * 60 * 1000 });
  }

  private clearAuthCookies(res: Response) {
    res.clearCookie('accessToken', { ...COOKIE_OPTS, path: '/api' });
    res.clearCookie('refreshToken', { ...COOKIE_OPTS, path: '/api/auth' });
  }

  @Get('ping')
  @SkipThrottle()
  @ApiOperation({ summary: 'Simple ping endpoint' })
  ping() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Post('login')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Login con email o teléfono + contraseña' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto);
    this.setAuthCookies(res, result.access_token, result.refresh_token);
    return { user: result.user };
  }

  @Post('register')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Registrar usuario' })
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.register(dto);
    this.setAuthCookies(res, result.access_token, result.refresh_token);
    return { user: result.user };
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
  async resetPassword(@Body() dto: ResetPasswordDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.resetPassword(dto);
    if (result.access_token) {
      this.setAuthCookies(res, result.access_token, result.refresh_token);
    }
    return { user: result.user };
  }

  @Post('refresh')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Renovar token de acceso' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Accept refresh token from body (legacy) or cookie (new)
    const refreshToken = dto.refreshToken || (req as any).cookies?.refreshToken;
    if (!refreshToken) throw new UnauthorizedException('Refresh token requerido');
    const result = await this.authService.refresh({ refreshToken });
    this.setAuthCookies(res, result.access_token, result.refresh_token);
    return { user: result.user };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Cerrar sesión (revocar refresh tokens)' })
  async logout(@CurrentUser() user: any, @Res({ passthrough: true }) res: Response) {
    await this.authService.revokeRefreshTokens(user.sub);
    this.clearAuthCookies(res);
    return { ok: true };
  }

  @Post('switch-company')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Cambiar empresa activa' })
  async switchCompany(
    @Body() dto: SwitchCompanyDto,
    @CurrentUser() user: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.switchCompany(user.sub, dto);
    this.setAuthCookies(res, result.access_token, result.refresh_token);
    return { user: result.user };
  }

  @Patch('password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({ summary: 'Cambiar contraseña (autenticado)' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.changePassword(user.sub, dto);
    // changePassword returns { ok, message, refresh_token } — set cookie
    if (result.refresh_token) {
      res.cookie('refreshToken', result.refresh_token, { ...COOKIE_OPTS, path: '/api/auth', maxAge: 7 * 24 * 60 * 60 * 1000 });
    }
    return { ok: result.ok, message: result.message };
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

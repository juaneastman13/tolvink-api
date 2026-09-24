import {
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf } from '../common/agro-base.controller';
import { AgroBcuService } from './agro-bcu.service';

@ApiTags('Agro / BCU')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/bcu')
export class AgroBcuController {
  constructor(
    private service: AgroBcuService,
    private scope: AgroScopeService,
  ) {}

  /**
   * Fuerza sincronización del TC del día contra BCU. Idempotente.
   * En producción, esto también se llama desde un cron diario.
   */
  @Post('sync')
  @AgroRoles('agro_admin')
  async sync(@CurrentUser() user: any, @Req() req: any) {
    const empresaId = await empresaIdOf(this.scope, user, req);
    const r = await this.service.sincronizarDia(empresaId);
    if (!r) {
      return { ok: false, mensaje: 'BCU no accesible; TC no actualizado' };
    }
    return { ok: true, tipoCambio: r };
  }
}

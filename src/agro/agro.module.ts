import { Module } from '@nestjs/common';
import { AgroScopeService } from './common/agro-scope.service';
import { AgroRolesGuard } from './common/agro-roles.guard';
import {
  AgroEmpresaController,
  AgroEmpresaService,
} from './empresa/agro-empresa.controller';
import { AgroSeedService } from './empresa/agro-seed.service';
import {
  AgroConfigController,
  AgroConfigService,
} from './config/agro-config.controller';
import {
  AgroMaestrosController,
  AgroMaestrosService,
} from './maestros/agro-maestros.controller';
import {
  AgroTipoCambioController,
  AgroTipoCambioService,
} from './tipo-cambio/agro-tipo-cambio.controller';

/**
 * Módulo de gestión agropecuaria (Cruz Del Sur). Aislado del módulo de
 * logística: sin imports de FreightsModule ni de módulos afines. Depende
 * únicamente de la infraestructura compartida (DatabaseModule global,
 * AuthModule via JwtAuthGuard).
 *
 * El acceso se protege con `ModuleAccessGuard('agro')` + `AgroRolesGuard`
 * en cada controller.
 */
@Module({
  imports: [],
  controllers: [
    AgroEmpresaController,
    AgroConfigController,
    AgroMaestrosController,
    AgroTipoCambioController,
  ],
  providers: [
    AgroScopeService,
    AgroRolesGuard,
    AgroSeedService,
    AgroEmpresaService,
    AgroConfigService,
    AgroMaestrosService,
    AgroTipoCambioService,
  ],
  exports: [AgroScopeService],
})
export class AgroModule {}

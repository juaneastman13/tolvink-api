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
import {
  AgroCamposController,
  AgroCamposService,
} from './campos/agro-campos.controller';
import {
  AgroLotesController,
  AgroLotesService,
} from './lotes/agro-lotes.controller';
import {
  AgroTandasController,
  AgroTandasService,
} from './tandas/agro-tandas.controller';
import {
  AgroPrestamosController,
  AgroPrestamosService,
} from './prestamos/agro-prestamos.controller';
import {
  AgroHaciendaController,
  AgroHaciendaService,
} from './hacienda/agro-hacienda.controller';
import {
  AgroGranosController,
  AgroGranosService,
} from './granos/agro-granos.controller';
import {
  AgroGastosController,
  AgroGastosService,
} from './gastos/agro-gastos.controller';
import {
  AgroLaboresController,
  AgroLaboresService,
} from './labores/agro-labores.controller';
import {
  AgroLluviasController,
  AgroLluviasService,
} from './lluvias/agro-lluvias.controller';
import {
  AgroImportController,
  AgroImportService,
} from './import/agro-import.controller';
import { AgroReportesController } from './reportes/agro-reportes.controller';
import { AgroReportesService } from './reportes/agro-reportes.service';
import { AgroDesviosService } from './reportes/agro-desvios.service';
import {
  AgroPresupuestoController,
  AgroPresupuestoService,
} from './presupuesto/agro-presupuesto.controller';
import {
  AgroCajaController,
  AgroCajaService,
} from './caja/agro-caja.controller';
import { AgroBcuController } from './bcu/agro-bcu.controller';
import { AgroBcuService } from './bcu/agro-bcu.service';
import {
  AgroExportController,
  AgroExportService,
} from './export/agro-export.controller';
import {
  AgroInformeController,
  AgroInformeService,
} from './informe/agro-informe.controller';

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
    AgroCamposController,
    AgroLotesController,
    AgroTandasController,
    AgroPrestamosController,
    AgroHaciendaController,
    AgroGranosController,
    AgroGastosController,
    AgroLaboresController,
    AgroLluviasController,
    AgroImportController,
    AgroReportesController,
    AgroPresupuestoController,
    AgroCajaController,
    AgroBcuController,
    AgroExportController,
    AgroInformeController,
  ],
  providers: [
    AgroScopeService,
    AgroRolesGuard,
    AgroSeedService,
    AgroEmpresaService,
    AgroConfigService,
    AgroMaestrosService,
    AgroTipoCambioService,
    AgroCamposService,
    AgroLotesService,
    AgroTandasService,
    AgroPrestamosService,
    AgroHaciendaService,
    AgroGranosService,
    AgroGastosService,
    AgroLaboresService,
    AgroLluviasService,
    AgroImportService,
    AgroReportesService,
    AgroDesviosService,
    AgroPresupuestoService,
    AgroCajaService,
    AgroBcuService,
    AgroExportService,
    AgroInformeService,
  ],
  exports: [AgroScopeService],
})
export class AgroModule {}

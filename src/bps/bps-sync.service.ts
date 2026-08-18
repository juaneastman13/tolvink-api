import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { releasePgLock, tryAcquirePgLock } from '../common/distributed-lock';
import { BpsClient } from './bps-client';
import { BpsService } from './bps.service';

const LOCK_KEY = 'bps-sync';
const FRECUENCIA_MS: Record<string, number> = {
  diaria: 24 * 60 * 60 * 1000,
  semanal: 7 * 24 * 60 * 60 * 1000,
  quincenal: 15 * 24 * 60 * 60 * 1000,
};

/**
 * Sincronización automática con BPS. Patrón de la casa: setInterval en
 * onModuleInit (sin BullMQ — no hay Redis configurado en el deploy), con
 * advisory lock de Postgres para ejecución única entre instancias.
 */
@Injectable()
export class BpsSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BpsSyncService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: BpsClient,
    private readonly bps: BpsService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('BPS_ENABLED') !== 'true') {
      this.logger.log('BPS deshabilitado (BPS_ENABLED != true) — sincronización automática inactiva');
      return;
    }
    const tickMs = parseInt(this.config.get<string>('BPS_SYNC_TICK_MS') || String(60 * 60 * 1000), 10);
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.logger.error(`Tick de sincronización BPS falló: ${e.message}`));
    }, tickMs);
    this.timer.unref();
    this.logger.log(`Sincronización BPS activa (tick cada ${Math.round(tickMs / 60000)} min)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    const locked = await tryAcquirePgLock(this.prisma, LOCK_KEY);
    if (!locked) return; // otra instancia está sincronizando
    try {
      await this.syncEmpresasMonitoreadas();
      await this.syncCuentas();
    } finally {
      await releasePgLock(this.prisma, LOCK_KEY);
    }
  }

  /** Consulta pública de vigencia para empresas monitoreadas vencidas según frecuencia. */
  private async syncEmpresasMonitoreadas() {
    const empresas = await this.prisma.bpsEmpresaMonitoreada.findMany({
      where: { active: true },
      orderBy: { ultimaConsulta: 'asc' },
      take: 200,
    });
    if (empresas.length === 0) return;

    const configs = await this.prisma.bpsConfig.findMany({
      where: { companyId: { in: Array.from(new Set(empresas.map((e) => e.companyId))) } },
    });
    const cfgMap = new Map(configs.map((c) => [c.companyId, c]));
    const now = Date.now();

    for (const empresa of empresas) {
      const frecuencia = cfgMap.get(empresa.companyId)?.frecuencia || 'diaria';
      const intervalo = FRECUENCIA_MS[frecuencia] || FRECUENCIA_MS.diaria;
      if (empresa.ultimaConsulta && now - empresa.ultimaConsulta.getTime() < intervalo) continue;
      try {
        const resultado = await this.client.consultarVigencia(empresa.rut);
        await this.bps.registrarConsulta(empresa, resultado);
      } catch (e: any) {
        // Error técnico: no cambiar el estado, solo registrar
        this.logger.warn(`Consulta de vigencia falló para RUT ${empresa.rut}: ${e.message}`);
      }
    }
  }

  /** Consultas autenticadas para cuentas con sync vencida (cada 24 h). */
  private async syncCuentas() {
    const limite = new Date(Date.now() - FRECUENCIA_MS.diaria);
    const cuentas = await this.prisma.bpsCuenta.findMany({
      where: { active: true, OR: [{ ultimaSync: null }, { ultimaSync: { lt: limite } }] },
      take: 50,
    });
    for (const cuenta of cuentas) {
      try {
        await this.bps.syncCuenta(cuenta, { notificar: true });
      } catch (e: any) {
        this.logger.warn(`Sync de cuenta BPS falló para empresa ${cuenta.companyId}: ${e.message}`);
      }
    }
  }
}

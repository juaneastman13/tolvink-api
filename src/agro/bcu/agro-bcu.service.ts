import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Integración con BCU (Banco Central del Uruguay).
 *
 * Obtiene la cotización oficial UYU/USD y la guarda en `agro_tipo_cambio`
 * con `fuente = 'BCU'`. Corre bajo demanda (endpoint admin) o vía cron
 * externo (Railway scheduled job / node-cron opcional).
 *
 * Endpoint BCU público (web service SOAP oficial):
 *   https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcumovimientos
 *
 * Aquí uso un fallback HTTP JSON simple (open.er-api.com o similar). Si el
 * proxy corporativo bloquea el destino, el operador puede setear
 * `AGRO_BCU_URL` a un endpoint interno o un mirror. Todos los cambios son
 * idempotentes: upsert por (empresaId, fecha).
 */
@Injectable()
export class AgroBcuService {
  private readonly logger = new Logger(AgroBcuService.name);
  /**
   * URL del feed de tipo de cambio. Puede ser el WS oficial del BCU (con
   * el operador que lo consume, en Fase 6/deploy) o un mirror JSON.
   * Formato esperado del JSON: { rates: { UYU: <number> } } o
   * { value: <number> }.
   */
  private readonly url =
    process.env.AGRO_BCU_URL ||
    'https://open.er-api.com/v6/latest/USD';

  /**
   * Fetch bruto: hace la request y devuelve el UYU/USD numérico, o null si falla.
   * Nunca tira: la falla se loguea y el llamador decide qué hacer.
   */
  async fetchUyuUsd(): Promise<number | null> {
    try {
      const res = await fetch(this.url, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) {
        this.logger.warn(`BCU fetch ${this.url} → HTTP ${res.status}`);
        return null;
      }
      const body: any = await res.json();
      // open.er-api.com: body.rates.UYU
      // ws mirror simple: body.value
      const val =
        body?.rates?.UYU ??
        body?.value ??
        body?.uyuUsd ??
        body?.UYU_USD ??
        null;
      if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
        this.logger.warn(`BCU respuesta inválida: ${JSON.stringify(body).slice(0, 200)}`);
        return null;
      }
      return val;
    } catch (e: any) {
      this.logger.warn(`BCU fetch error: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Descarga y persiste el TC del día para una empresa. Idempotente.
   * Retorna el registro creado/actualizado, o null si el fetch falló.
   */
  async sincronizarDia(empresaId: string, fecha: Date = new Date()) {
    const val = await this.fetchUyuUsd();
    if (val === null) return null;
    const day = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
    return this.prisma?.agroTipoCambio.upsert({
      where: { empresaId_fecha: { empresaId, fecha: day } },
      create: {
        empresaId,
        fecha: day,
        uyuUsd: new Prisma.Decimal(val),
        fuente: 'BCU',
      },
      update: {
        uyuUsd: new Prisma.Decimal(val),
        fuente: 'BCU',
      },
    });
  }

  /**
   * Sincroniza el TC del día para TODAS las empresas activas de una Company.
   * Útil para un cron diario.
   */
  async sincronizarTodas(fecha: Date = new Date()) {
    const empresas = await this.prisma.agroEmpresa.findMany({
      where: { active: true },
      select: { id: true },
    });
    const results: Array<{ empresaId: string; ok: boolean }> = [];
    for (const e of empresas) {
      const r = await this.sincronizarDia(e.id, fecha);
      results.push({ empresaId: e.id, ok: !!r });
    }
    return results;
  }

  constructor(private prisma: PrismaService) {}
}

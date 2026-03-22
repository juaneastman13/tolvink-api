// =====================================================================
// TOLVINK — Location / Map / Tracking Tool Handlers
// Extracted from ai.service.ts for modularity
// =====================================================================

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { SessionManagerService } from '../session/session-manager.service';
import { AiContextService } from './ai-context.service';
import { createSignedToken } from '../../common/signed-token';
import { APP_URL } from '../ai.constants';
import {
  hasType as _hasType,
} from '../ai.utils';
import { nanoid } from 'nanoid';
import * as crypto from 'crypto';

@Injectable()
export class LocationToolsService {
  private readonly logger = new Logger(LocationToolsService.name);
  _requestLocationCooldowns = new Map<string, number>();

  /** Clean expired cooldown entries and enforce hard cap */
  cleanupCooldowns(): void {
    const now = Date.now();
    for (const [k, v] of this._requestLocationCooldowns) {
      if (now - v > 5 * 60 * 1000) this._requestLocationCooldowns.delete(k);
    }
    if (this._requestLocationCooldowns.size > 5000) {
      const iter = this._requestLocationCooldowns.keys();
      while (this._requestLocationCooldowns.size > 4000) {
        const k = iter.next().value;
        if (k) this._requestLocationCooldowns.delete(k); else break;
      }
    }
  }

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => WhatsAppService)) private wa: WhatsAppService,
    private sessionManager: SessionManagerService,
    private aiContext: AiContextService,
  ) {}

  // ======================== SHARED HELPERS ================================

  /** Fetch freight by code, check access, ensure shareToken exists. Returns { freight, token } or error JSON. */
  private async fetchFreightAndEnsureToken(
    code: string,
    user: any,
    options?: { rejectFinished?: boolean },
  ): Promise<{ freight: any; token: string } | { error: string }> {
    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, shareToken: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });
    if (!freight) return { error: `Flete ${code} no encontrado` };

    // Access control
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return { error: `No tiene acceso al flete ${code}` };
    }

    if (options?.rejectFinished && ['finished', 'canceled'].includes(freight.status)) {
      return { error: `El flete ${code} ya está ${freight.status === 'finished' ? 'finalizado' : 'cancelado'}` };
    }

    // Ensure shareToken
    let token = freight.shareToken;
    if (!token) {
      token = crypto.randomUUID();
      await this.prisma.freight.update({
        where: { id: freight.id },
        data: { shareToken: token, shareTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      });
    }

    return { freight, token };
  }

  // ======================== NAVIGATE APP ================================

  toolNavigateApp(input: any, session: any): string {
    const { screen, freightId } = input;
    const effects = this.sessionManager.getSideEffects(session.id);
    effects._navigate = { screen, freightId: freightId || undefined };
    this.sessionManager.setSideEffects(session.id, effects);
    return JSON.stringify({ status: 'ok', navigated: screen });
  }

  // ======================== GENERATE LOCATION LINK ======================

  toolGenerateLocationLink(input: any, session: any): string {
    const token = crypto.randomUUID();
    const purposeLabel = (input.purpose || 'campo').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
    const slug = `${purposeLabel}-${crypto.randomBytes(8).toString('hex')}`;

    // Use side-effects pattern (merged by chat()) — avoids direct DB write race
    const effects = this.sessionManager.getSideEffects(session.id);
    effects.locationToken = {
      token,
      slug,
      purpose: input.purpose || 'general',
      createdAt: new Date().toISOString(),
    };
    effects._pendingButtons = [
      { id: 'location_done', title: 'UBICACIÓN LISTA' },
    ];
    this.sessionManager.setSideEffects(session.id, effects);

    this.logger.log(`generate_location_link — slug=${slug}, sessionId=${session.id}`);

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/ubicacion/${slug}`;

    const purposeLabels: Record<string, string> = {
      origin: 'origen del flete',
      destination: 'destino del flete',
      field: 'ubicación del campo',
      lot: 'ubicación del lote',
    };
    const label = purposeLabels[input.purpose] || 'ubicación';

    return JSON.stringify({
      url,
      message: `Abra el siguiente enlace para marcar el ${label} en el mapa. Una vez confirmada la ubicación, presione el botón "UBICACIÓN LISTA".`,
    });
  }

  // ---- generate_tracking_link ----
  async toolGenerateTrackingLink(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const result = await this.fetchFreightAndEnsureToken(code, user, { rejectFinished: true });
    if ('error' in result) return JSON.stringify({ error: result.error });

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/${result.freight.code}/ubicacion?s=${result.token}`;

    return JSON.stringify({
      url,
      message: `Aquí tiene el enlace de seguimiento en vivo del flete ${code}. Ábralo para ver la ruta y posición del camión en tiempo real.`,
    });
  }

  // ---- generate_map_link ----
  toolGenerateMapLink(input: any): string {
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (isNaN(lat) || isNaN(lng) || !isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return JSON.stringify({ error: 'Coordenadas inválidas (lat: -90..90, lng: -180..180)' });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const params = new URLSearchParams();
    params.set('lat', lat.toFixed(6));
    params.set('lng', lng.toFixed(6));
    params.set('n', (input.name || 'Ubicación').slice(0, 60));
    if (input.destLat != null && input.destLng != null) {
      const dlat = Number(input.destLat), dlng = Number(input.destLng);
      if (!isNaN(dlat) && !isNaN(dlng) && isFinite(dlat) && isFinite(dlng) && dlat >= -90 && dlat <= 90 && dlng >= -180 && dlng <= 180) {
        params.set('dlat', dlat.toFixed(6));
        params.set('dlng', dlng.toFixed(6));
        if (input.destName) params.set('dn', input.destName.slice(0, 60));
      }
    }
    const url = `${frontendUrl}/ver-mapa?${params.toString()}`;

    return JSON.stringify({
      url,
      message: `Abra el link para ver la ubicación de ${input.name || 'este punto'} en el mapa Tolvink.`,
    });
  }

  // ---- generate_report_link ----
  async toolGenerateReportLink(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const result = await this.fetchFreightAndEnsureToken(code, user);
    if ('error' in result) return JSON.stringify({ error: result.error });

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/${result.freight.code}/informe?s=${result.token}`;

    return JSON.stringify({
      url,
      message: `Aquí tiene el enlace para descargar el informe PDF del flete ${code}. Ábralo desde cualquier dispositivo.`,
    });
  }

  // ---- generate_shared_link ----
  async toolGenerateSharedLink(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar la empresa activa.' });

    // Find the freight
    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: { id: true, code: true, originCompanyId: true, destCompanyId: true, producerCompanyId: true },
    });
    if (!freight) return JSON.stringify({ error: `No se encontró el flete ${code}` });

    // Determine target company (producer by default, or use explicit param)
    const targetCompanyId = input.targetCompanyId || freight.producerCompanyId || freight.originCompanyId || companyId;

    // Check if there's already an active shared link for this freight+target
    const existing = await this.prisma.sharedLink.findFirst({
      where: {
        freightId: freight.id,
        targetCompanyId,
        linkType: 'FREIGHT',
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });

    if (existing) {
      const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
      return JSON.stringify({
        url: `${frontendUrl}/s/${existing.token}`,
        message: `Link de seguimiento del flete ${code}. Compartilo con quien necesite ver el estado del flete.`,
        isReused: true,
      });
    }

    // Create new shared link
    const link = await this.prisma.sharedLink.create({
      data: {
        token: nanoid(21),
        linkType: 'FREIGHT',
        creatorCompanyId: companyId,
        targetCompanyId,
        freightId: freight.id,
        createdById: user.id,
        createdVia: 'WHATSAPP',
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000), // 72h
      },
    });

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    return JSON.stringify({
      url: `${frontendUrl}/s/${link.token}`,
      message: `Link de seguimiento del flete ${code}. Válido por 72 horas. Compartilo con quien necesite ver el estado del flete.`,
      isReused: false,
    });
  }

  // ---- generate_daily_map_link ----
  async toolGenerateDailyMapLink(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar la empresa activa.' });

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) return JSON.stringify({ error: 'Configuración del servidor incompleta.' });

    const token = createSignedToken({ uid: user.id, cid: companyId, purpose: 'daily_map' }, secret, 1440); // 24h

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/daily-map?t=${token}`;

    return JSON.stringify({
      url,
      message: 'Abra el siguiente link para ver el mapa con todos los fletes del día. Puede filtrar por estado y tocar cada marcador para ver detalles.',
    });
  }

  // ---- share_live_location ----
  async toolShareLiveLocation(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    if (['finished', 'canceled'].includes(freight.status)) {
      return JSON.stringify({ error: `El flete ${code} está ${freight.status === 'finished' ? 'finalizado' : 'cancelado'}. Solo se puede compartir ubicación en fletes activos.` });
    }

    // Access control
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) return JSON.stringify({ error: 'Configuración del servidor incompleta.' });

    const companyType = this.aiContext.resolveCompanyType(user);
    const role = _hasType(companyType, 'chofer') ? 'chofer'
      : _hasType(companyType, 'transporter') ? 'transporter'
      : _hasType(companyType, 'plant') ? 'plant' : 'producer';

    const token = createSignedToken(
      { uid: user.id, cid: userCompanyId, fid: freight.id, role, name: user.name || 'Usuario', purpose: 'live_location' },
      secret,
      120, // 2h
    );

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/live-freight?t=${token}&mode=share`;

    return JSON.stringify({
      url,
      message: `Abra el siguiente link para compartir su ubicación en tiempo real en el flete ${code}. Los demás participantes del flete podrán ver su posición en el mapa.`,
    });
  }

  // ---- view_live_locations ----
  async toolViewLiveLocations(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access control
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) return JSON.stringify({ error: 'Configuración del servidor incompleta.' });

    const token = createSignedToken(
      { uid: user.id, cid: userCompanyId, fid: freight.id, purpose: 'view_locations' },
      secret,
      120, // 2h
    );

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/live-freight?t=${token}&mode=view`;

    return JSON.stringify({
      url,
      message: `Abra el siguiente link para ver las ubicaciones en tiempo real de los participantes del flete ${code}.`,
    });
  }

  // ---- request_location ----
  async toolRequestLocation(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, code: true, status: true,
        originName: true, destName: true,
        originCompanyId: true, destCompanyId: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: {
            transportCompanyId: true,
            driverId: true,
            driver: { select: { phone: true, name: true, id: true } },
          },
        },
      },
    });
    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access check
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId,
      ...freight.assignments.map(a => a.transportCompanyId)].filter(Boolean);
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    if (!['in_progress', 'loaded', 'accepted'].includes(freight.status)) {
      return JSON.stringify({ error: `El flete ${code} no está activo (estado: ${freight.status})` });
    }

    // Cooldown: max 1 request_location per freight per 5 minutes
    const cooldownKey = `req_loc_${freight.id}`;
    const now = Date.now();
    if ((this._requestLocationCooldowns.get(cooldownKey) || 0) > now) {
      return JSON.stringify({ error: `Ya se solicitó ubicación para ${code} hace poco. Intente en unos minutos.` });
    }
    this._requestLocationCooldowns.set(cooldownKey, now + 5 * 60 * 1000);

    // Collect all participant companies
    const companyIds = new Set<string>();
    if (freight.originCompanyId) companyIds.add(freight.originCompanyId);
    if (freight.destCompanyId) companyIds.add(freight.destCompanyId);
    for (const a of freight.assignments) {
      if (a.transportCompanyId) companyIds.add(a.transportCompanyId);
    }

    const participants = await this.prisma.user.findMany({
      where: {
        phone: { not: null },
        active: true,
        OR: [
          { companyId: { in: Array.from(companyIds) } },
          { memberships: { some: { companyId: { in: Array.from(companyIds) }, active: true } } },
        ],
      },
      select: { phone: true, id: true, name: true },
      take: 50,
    });

    // Merge drivers + company users, deduplicate, exclude requester
    const allTargets = new Map<string, { phone: string; name: string }>();
    for (const a of freight.assignments) {
      const d = a.driver;
      if (d?.phone && d.id !== user.id) allTargets.set(d.id, { phone: d.phone, name: d.name || 'Chofer' });
    }
    for (const p of participants) {
      if (p.id !== user.id && !allTargets.has(p.id)) {
        allTargets.set(p.id, { phone: p.phone!, name: p.name || 'Usuario' });
      }
    }

    if (allTargets.size === 0) {
      return JSON.stringify({ error: 'No hay participantes con WhatsApp a quienes solicitar ubicación' });
    }

    const requesterName = user.name?.split(' ')[0] || 'Un participante';
    const msg = `*Solicitud de ubicación*\n${requesterName} solicita su ubicación para el flete ${freight.code} (${freight.originName} → ${freight.destName}).\n\nEnvíe su ubicación en este chat (adjuntar → Ubicación).`;

    const results = await Promise.allSettled(
      [...allTargets.values()].map((target) =>
        this.wa.sendText(target.phone, msg).catch((err) => {
          this.logger.warn(`[requestLocation] send to ${target.phone} failed: ${err.message}`);
          throw err;
        }),
      ),
    );
    const sent = results.filter((r) => r.status === 'fulfilled').length;

    return JSON.stringify({
      status: 'ok',
      message: `Solicitud enviada a ${sent} participante${sent > 1 ? 's' : ''}`,
      sent,
    });
  }

  // ---- generate_batch_report_link ----
  async toolGenerateBatchReportLink(input: any, _user: any): Promise<string> {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.dateFrom) params.set('from', input.dateFrom);
    if (input.dateTo) params.set('to', input.dateTo);
    const qs = params.toString();
    const url = `${APP_URL}/reports${qs ? `?${qs}` : ''}`;
    return JSON.stringify({ url, message: `Enlace a reportes: ${url}\nDesde ahí puede descargar PDF o Excel con los filtros aplicados.` });
  }

  // ======================== POST-START TRACKING MESSAGES =================

  /**
   * Fire-and-forget: after a freight is started, send tracking links to stakeholders
   * and prompt the driver to share GPS location.
   */
  async sendPostStartTrackingMessages(freightId: string, code: string, triggerUser: any): Promise<void> {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: {
        id: true, code: true, shareToken: true,
        originName: true, destName: true,
        originCompanyId: true, destCompanyId: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: {
            transportCompanyId: true,
            driverId: true,
            driver: { select: { phone: true, name: true, id: true } },
          },
        },
      },
    });
    if (!freight) return;

    // Ensure shareToken exists for tracking URL
    let shareToken = freight.shareToken;
    if (!shareToken) {
      shareToken = crypto.randomUUID();
      await this.prisma.freight.update({ where: { id: freightId }, data: { shareToken, shareTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const trackingUrl = `${frontendUrl}/${freight.code}/ubicacion?s=${shareToken}`;

    // 1) Build all messages first, then send in parallel
    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    const sends: Promise<any>[] = [];

    // Driver messages (GPS sharing request)
    for (const a of freight.assignments) {
      const driver = a.driver;
      if (!driver?.phone) continue;

      let liveShareUrl = '';
      if (secret) {
        const token = createSignedToken(
          { uid: driver.id, cid: a.transportCompanyId, fid: freight.id, role: 'chofer', name: driver.name || 'Chofer' },
          secret, 120,
        );
        liveShareUrl = `${frontendUrl}/live-freight?t=${token}&mode=share`;
      }

      const driverMsg = `*Flete ${freight.code} iniciado*\n${freight.originName} \u2192 ${freight.destName}\n\n`
        + `Puede enviar su ubicación en este chat (adjuntar \u2192 Ubicación) para que las empresas sigan el viaje.\n\n`
        + `Seguimiento: ${trackingUrl}`;

      sends.push(this.wa.sendText(driver.phone, driverMsg));
    }

    // 2) Stakeholder messages (tracking link)
    const companyIds = new Set<string>();
    if (freight.originCompanyId) companyIds.add(freight.originCompanyId);
    if (freight.destCompanyId) companyIds.add(freight.destCompanyId);
    for (const a of freight.assignments) {
      if (a.transportCompanyId) companyIds.add(a.transportCompanyId);
    }

    const stakeholders = await this.prisma.user.findMany({
      where: {
        phone: { not: null },
        active: true,
        OR: [
          { companyId: { in: Array.from(companyIds) }, role: { in: ['admin', 'platform_admin'] } },
          { memberships: { some: { companyId: { in: Array.from(companyIds) }, active: true, role: { in: ['gerente', 'admin'] } } } },
        ],
      },
      select: { phone: true, id: true, companyId: true },
      take: 30,
    });

    const driverIds = new Set(freight.assignments.map(a => a.driverId).filter(Boolean));
    const triggerUserId = triggerUser.id;

    for (const s of stakeholders) {
      if (driverIds.has(s.id) || s.id === triggerUserId) continue;
      if (!s.phone) continue;

      let liveViewUrl = '';
      if (secret && s.companyId) {
        const viewToken = createSignedToken(
          { uid: s.id, cid: s.companyId, fid: freight.id },
          secret, 120,
        );
        liveViewUrl = `${frontendUrl}/live-freight?t=${viewToken}&mode=view`;
      }

      const trackMsg = `*Flete ${freight.code} a campo*\n${freight.originName} → ${freight.destName}\n\n`
        + `Seguimiento en vivo: ${liveViewUrl || trackingUrl}`;

      sends.push(this.wa.sendText(s.phone, trackMsg));
    }

    // Send all messages in parallel
    await Promise.allSettled(sends);
  }
}

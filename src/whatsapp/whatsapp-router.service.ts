// =====================================================================
// TOLVINK — WhatsApp Message Router
// Routes incoming WhatsApp messages to appropriate handlers
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';
import { FreightsService } from '../freights/freights.service';

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  pending_assignment: 'Sin asignar',
  assigned: 'Asignado',
  accepted: 'Aceptado',
  in_progress: 'En camino',
  loaded: 'Cargado',
  finished: 'Finalizado',
  canceled: 'Cancelado',
};

const STATUS_EMOJI: Record<string, string> = {
  draft: '📝',
  pending_assignment: '⏳',
  assigned: '📋',
  accepted: '✅',
  in_progress: '🚛',
  loaded: '📦',
  finished: '🏁',
  canceled: '❌',
};

const APP_URL = 'https://tolvink.vercel.app';

@Injectable()
export class WhatsAppRouterService {
  private readonly logger = new Logger(WhatsAppRouterService.name);

  constructor(
    private prisma: PrismaService,
    private wa: WhatsAppService,
    private flow: WhatsAppFlowService,
    private freights: FreightsService,
  ) {}

  // ======================== MAIN ENTRY POINT ============================

  async handleMessage(phone: string, type: string, payload: any, waMessageId: string) {
    try {
      // Mark as read
      this.wa.markRead(waMessageId).catch(() => {});

      // Find user by phone
      const normalized = this.wa.normalizePhone(phone);
      const user = await this.findUserByPhone(phone);

      if (!user) {
        await this.wa.sendText(phone,
          'Este numero no esta registrado en Tolvink.\n\n' +
          `Registrate en la app primero: ${APP_URL}`,
        );
        return;
      }

      // Check for active flow
      const session = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });

      if (session?.flowType) {
        // Handle cancel/menu command inside any flow
        const cmd = type === 'text' ? payload.body?.trim().toLowerCase() : '';
        if (/^(cancelar|salir|exit|cancel)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.wa.sendText(phone, 'Operacion cancelada.');
          await this.showMainMenu(phone, user);
          return;
        }
        if (/^(menu|inicio|hola)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.showMainMenu(phone, user);
          return;
        }

        await this.flow.continueFlow(session, type, payload, phone, user);
        return;
      }

      // Route by message type
      if (type === 'button_reply') {
        await this.handleButtonReply(phone, user, payload.id, payload.title);
      } else if (type === 'list_reply') {
        await this.handleListReply(phone, user, payload.id, payload.title);
      } else if (type === 'text') {
        await this.handleText(phone, user, payload.body || '');
      } else {
        await this.wa.sendText(phone, 'Por ahora solo puedo procesar mensajes de texto. Escribi *menu* para ver las opciones.');
      }
    } catch (e) {
      this.logger.error(`handleMessage error for ${phone}: ${e.message}`, e.stack);
      await this.wa.sendText(phone, 'Ocurrio un error procesando tu mensaje. Intenta de nuevo.');
    }
  }

  // ======================== TEXT HANDLER =================================

  private async handleText(phone: string, user: any, text: string) {
    const t = text.trim();

    // Freight code lookup
    if (/^FLT-\d{4,}$/i.test(t)) {
      await this.showFreightByCode(phone, user, t.toUpperCase());
      return;
    }

    // Intent matching
    if (/^(estado|status|mis fletes|fletes)$/i.test(t)) {
      await this.showActiveFreights(phone, user);
      return;
    }

    if (/^(crear|nuevo|nuevo flete|solicitar)$/i.test(t)) {
      await this.flow.startFlow('create_freight', phone, user);
      return;
    }

    if (/^(ayuda|help|menu|hola|hi|inicio)$/i.test(t)) {
      await this.showMainMenu(phone, user);
      return;
    }

    // Default: show menu
    await this.showMainMenu(phone, user);
  }

  // ======================== BUTTON REPLY HANDLER ========================

  private async handleButtonReply(phone: string, user: any, buttonId: string, title: string) {
    // Button ID format: "action:entityId" or "action:entityId:extra"
    const parts = buttonId.split(':');
    const action = parts[0];
    const entityId = parts[1] || '';

    const synUser = this.buildSyntheticUser(user);

    try {
      switch (action) {
        case 'accept': {
          await this.freights.respond(entityId, { action: 'accepted' } as any, synUser);
          await this.wa.sendText(phone, '✅ Flete aceptado correctamente.');
          break;
        }
        case 'reject': {
          // Start reject flow (needs reason)
          await this.flow.startFlow('reject_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'start': {
          await this.freights.start(entityId, synUser);
          await this.wa.sendText(phone, '🚛 Viaje iniciado. Buen camino!');
          break;
        }
        case 'confirm_loaded': {
          // Start loaded flow (needs tons)
          await this.flow.startFlow('confirm_loaded', phone, user, { freightId: entityId });
          break;
        }
        case 'confirm_finished': {
          await this.freights.confirmFinished(entityId, synUser);
          await this.wa.sendText(phone, '🏁 Entrega confirmada.');
          break;
        }
        case 'cancel': {
          // Start cancel flow (needs reason)
          await this.flow.startFlow('cancel_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'detail': {
          await this.showFreightDetail(phone, user, entityId);
          break;
        }
        case 'menu': {
          await this.showMainMenu(phone, user);
          break;
        }
        case 'active_freights': {
          await this.showActiveFreights(phone, user);
          break;
        }
        case 'create_freight': {
          await this.flow.startFlow('create_freight', phone, user);
          break;
        }
        case 'show_help': {
          await this.showHelp(phone, user);
          break;
        }
        default: {
          await this.wa.sendText(phone, 'Accion no reconocida. Escribi *menu* para ver opciones.');
        }
      }
    } catch (e) {
      this.logger.error(`Button action "${action}" failed: ${e.message}`);
      await this.wa.sendText(phone, `Error: ${e.message}`);
    }
  }

  // ======================== LIST REPLY HANDLER ==========================

  private async handleListReply(phone: string, user: any, listId: string, title: string) {
    // List IDs: "freight:uuid" or "action:freightId"
    const parts = listId.split(':');
    const type = parts[0];
    const id = parts.slice(1).join(':');

    if (type === 'freight') {
      await this.showFreightDetail(phone, user, id);
    } else {
      // Treat as button reply for action-based lists
      await this.handleButtonReply(phone, user, listId, title);
    }
  }

  // ======================== SHOW MAIN MENU ==============================

  async showMainMenu(phone: string, user: any) {
    const name = user.name?.split(' ')[0] || 'usuario';

    await this.wa.sendButtons(phone,
      `Hola ${name}! Soy el asistente de *Tolvink*.\n\n` +
      `Que necesitas hacer?\n\n📱 ${APP_URL}`,
      [
        { id: 'active_freights', title: 'MIS FLETES' },
        { id: 'create_freight', title: 'CREAR FLETE' },
        { id: 'show_help', title: 'AYUDA' },
      ],
    );
  }

  // ======================== SHOW HELP ==================================

  private async showHelp(phone: string, user: any) {
    const name = user.name?.split(' ')[0] || 'usuario';

    await this.wa.sendText(phone,
      `*Ayuda de Tolvink* 📋\n` +
      `━━━━━━━━━━━━━━━\n\n` +
      `*Comandos disponibles:*\n` +
      `• Escribi *menu* → ver opciones principales\n` +
      `• Escribi *crear* → crear un nuevo flete\n` +
      `• Escribi *fletes* → ver tus fletes activos\n` +
      `• Escribi un codigo (ej: *FLT-0001*) → ver detalle de un flete\n` +
      `• Escribi *cancelar* → salir de cualquier operacion en curso\n\n` +
      `*Que puedo hacer:*\n` +
      `📦 Crear fletes con grano, toneladas, planta y fecha\n` +
      `📋 Ver el estado de tus fletes activos\n` +
      `✅ Aceptar o rechazar asignaciones\n` +
      `🚛 Iniciar viajes y confirmar cargas/entregas\n` +
      `❌ Cancelar fletes\n\n` +
      `Si necesitas mas ayuda, contactanos en la app:\n${APP_URL}`,
    );

    await this.wa.sendButtons(phone,
      'Que queres hacer?',
      [
        { id: 'active_freights', title: 'MIS FLETES' },
        { id: 'create_freight', title: 'CREAR FLETE' },
        { id: 'menu', title: 'VOLVER AL MENU' },
      ],
    );
  }

  // ======================== SHOW ACTIVE FREIGHTS ========================

  async showActiveFreights(phone: string, user: any) {
    // Resolve the user's active company — only show freights for that company
    const activeCompanyId = user.activeCompanyId || user.companyId;

    if (!activeCompanyId) {
      await this.wa.sendText(phone, 'No tenes una empresa activa configurada.');
      return;
    }

    // Query freights where the active company participates
    const activeFreights = await this.prisma.freight.findMany({
      where: {
        status: { notIn: ['finished', 'canceled'] },
        OR: [
          { originCompanyId: activeCompanyId },
          { destCompanyId: activeCompanyId },
          {
            assignments: {
              some: {
                transportCompanyId: activeCompanyId,
                status: { in: ['active', 'accepted'] },
              },
            },
          },
          {
            assignments: {
              some: {
                driverId: user.id,
                status: { in: ['active', 'accepted'] },
              },
            },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        items: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (activeFreights.length === 0) {
      await this.wa.sendText(phone, 'No tenes fletes activos en este momento.');
      return;
    }

    // Build list message
    const rows = activeFreights.slice(0, 10).map((f: any) => {
      const grain = f.items?.[0]?.grain || 'Sin grano';
      const tons = f.items?.[0]?.tons || '?';
      const emoji = STATUS_EMOJI[f.status] || '';
      const label = STATUS_LABELS[f.status] || f.status;

      return {
        id: `freight:${f.id}`,
        title: f.code,
        description: `${emoji} ${label} | ${grain} ${tons}tn`,
      };
    });

    await this.wa.sendList(phone,
      `Tenes *${activeFreights.length}* flete${activeFreights.length > 1 ? 's' : ''} activo${activeFreights.length > 1 ? 's' : ''}:\n\n📱 ${APP_URL}`,
      'VER FLETES',
      [{ title: 'FLETES ACTIVOS', rows }],
    );
  }

  // ======================== SHOW FREIGHT BY CODE ========================

  private async showFreightByCode(phone: string, user: any, code: string) {
    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: { id: true },
    });

    if (!freight) {
      await this.wa.sendText(phone, `No se encontro el flete ${code}.`);
      return;
    }

    await this.showFreightDetail(phone, user, freight.id);
  }

  // ======================== SHOW FREIGHT DETAIL =========================

  async showFreightDetail(phone: string, user: any, freightId: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: {
        items: true,
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { id: true, name: true } },
            driver: { select: { id: true, name: true } },
            truck: { select: { id: true, plate: true } },
          },
        },
      },
    });

    if (!freight) {
      await this.wa.sendText(phone, 'Flete no encontrado.');
      return;
    }

    // Verify access using active company only
    const activeCompanyId = user.activeCompanyId || user.companyId;
    const isDriver = freight.assignments.some(a => a.driverId === user.id);
    const hasAccess =
      activeCompanyId === freight.originCompanyId ||
      activeCompanyId === freight.destCompanyId ||
      freight.assignments.some(a => a.transportCompanyId === activeCompanyId) ||
      isDriver;

    if (!hasAccess) {
      await this.wa.sendText(phone, 'No tenes acceso a este flete con tu empresa activa.');
      return;
    }

    const emoji = STATUS_EMOJI[freight.status] || '';
    const statusLabel = STATUS_LABELS[freight.status] || freight.status;

    // Build detail text
    const items = freight.items.map((i: any) => `${i.grain} ${i.tons}tn`).join(', ');
    const assignment = freight.assignments[0];
    const transportLine = assignment
      ? `🚚 ${assignment.transportCompany?.name || 'Transportista'}${assignment.truck ? ` (${assignment.truck.plate})` : ''}${assignment.driver ? ` - ${assignment.driver.name}` : ''}`
      : '🚚 Sin transportista asignado';

    const loadDate = freight.loadDate
      ? new Date(freight.loadDate).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';

    let text = `*${freight.code}* — ${emoji} ${statusLabel}\n`;
    text += '━━━━━━━━━━━━━━━\n';
    text += `📦 ${items}\n`;
    text += `📍 ${freight.originName || freight.originCompany?.name || 'Origen'} → ${freight.destName || freight.destCompany?.name || 'Destino'}\n`;
    text += `${transportLine}\n`;
    if (loadDate) text += `📅 ${loadDate}${freight.loadTime ? ` ${freight.loadTime}` : ''}\n`;
    if (freight.notes) text += `📝 ${freight.notes}\n`;
    text += `\n📱 Ver en la app: ${APP_URL}/freights/${freight.id}`;

    // Determine pending actions based on user's active company role
    const buttons = this.getActionButtons(freight, user, activeCompanyId);

    if (buttons.length > 0) {
      await this.wa.sendButtons(phone, text, buttons);
    } else {
      await this.wa.sendText(phone, text);
    }
  }

  // ======================== GET ACTION BUTTONS ==========================

  private getActionButtons(freight: any, user: any, activeCompanyId: string) {
    const buttons: { id: string; title: string }[] = [];
    const assignment = freight.assignments?.[0];
    const isOwnFleet = assignment?.transportCompanyId === freight.originCompanyId;

    // Determine user's role in this freight based on active company
    const isOrigin = activeCompanyId === freight.originCompanyId;
    const isDest = activeCompanyId === freight.destCompanyId;
    const isTransporter = assignment && activeCompanyId === assignment.transportCompanyId;
    const isDriver = assignment?.driverId === user.id;
    const isTransporterRole = isTransporter || isDriver || (isOrigin && isOwnFleet);

    switch (freight.status) {
      case 'assigned':
        if (isTransporterRole) {
          buttons.push({ id: `accept:${freight.id}`, title: 'ACEPTAR' });
          buttons.push({ id: `reject:${freight.id}`, title: 'RECHAZAR' });
        }
        break;

      case 'accepted':
        if (isTransporterRole) {
          buttons.push({ id: `start:${freight.id}`, title: 'INICIAR VIAJE' });
        }
        break;

      case 'in_progress':
        if (isTransporterRole) {
          buttons.push({ id: `confirm_loaded:${freight.id}`, title: 'CONFIRMAR CARGA' });
        }
        break;

      case 'loaded':
        if (isTransporterRole && !freight.transporterFinishedConfirmedAt) {
          buttons.push({ id: `confirm_finished:${freight.id}`, title: 'CONFIRMAR ENTREGA' });
        }
        if (isDest && !freight.plantFinishedConfirmedAt) {
          buttons.push({ id: `confirm_finished:${freight.id}`, title: 'CONFIRMAR RECEPCION' });
        }
        if (isOrigin && !isOwnFleet && !freight.producerLoadedConfirmedAt) {
          buttons.push({ id: `confirm_loaded:${freight.id}`, title: 'CONFIRMAR CARGA' });
        }
        break;
    }

    // Max 3 buttons — trim if needed
    return buttons.slice(0, 3);
  }

  // ======================== USER LOOKUP =================================

  private async findUserByPhone(phone: string): Promise<any | null> {
    const normalized = this.wa.normalizePhone(phone);

    // Try multiple formats
    const variants = [
      normalized,
      '+' + normalized,
      '0' + normalized.slice(3), // 598 → 0xx
    ];

    const user = await this.prisma.user.findFirst({
      where: {
        active: true,
        OR: variants.map(p => ({ phone: p })),
      },
      include: {
        company: { select: { id: true, name: true, type: true, types: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, types: true } } },
        },
      },
    });

    return user;
  }

  // ======================== BUILD SYNTHETIC USER ========================

  buildSyntheticUser(dbUser: any): any {
    // Build a user object compatible with FreightsService methods
    const companyByType = (dbUser.companyByType as any) || {};
    const userTypes = Array.isArray(dbUser.userTypes) ? dbUser.userTypes : [];

    // Determine primary company type from memberships
    let companyType = 'unknown';
    let companyId = dbUser.activeCompanyId || dbUser.companyId || '';

    if (userTypes.length > 0) {
      companyType = userTypes[0];
    } else if (dbUser.company?.type) {
      companyType = dbUser.company.type;
    } else if (dbUser.memberships?.length > 0) {
      const firstMembership = dbUser.memberships[0];
      const types = Array.isArray(firstMembership.company?.types) && firstMembership.company.types.length > 0
        ? firstMembership.company.types
        : [firstMembership.company?.type];
      companyType = types[0] || 'unknown';
      companyId = companyId || firstMembership.companyId;
    }

    return {
      sub: dbUser.id,
      role: dbUser.role || 'operator',
      companyId,
      companyType,
      userType: companyType,
      activeCompanyId: dbUser.activeCompanyId,
    };
  }
}

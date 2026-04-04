import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { FREIGHT_STATUS_SHORT } from '../ai.constants';

export interface InterceptResult {
  handled: boolean;
  response?: string;
  interactive?: any;
  navigate?: { screen: string; params?: Record<string, string> };
  action?: string;
}

@Injectable()
export class MessageInterceptorService {
  private readonly logger = new Logger(MessageInterceptorService.name);

  constructor(private prisma: PrismaService) {}

  async intercept(
    message: string,
    user: any,
    companyType: string,
    sessionState: any,
    isWeb: boolean,
    buttonId?: string,
  ): Promise<InterceptResult> {
    const msg = message.trim();
    const msgLower = msg.toLowerCase();

    if (buttonId) {
      return this.handleButton(buttonId, isWeb);
    }

    if (this.isGreeting(msgLower)) {
      return {
        handled: true,
        response: '¡Hola! ¿Qué necesitás?',
        interactive: this.buildMainMenu(companyType, isWeb),
        action: 'greeting',
      };
    }

    if (this.isGoodbye(msgLower)) {
      return { handled: true, response: '¡Hasta luego! Cualquier cosa escribime.', action: 'goodbye' };
    }

    if (this.isThanks(msgLower)) {
      return { handled: true, response: '¡De nada! ¿Necesitás algo más?', action: 'thanks' };
    }

    if (this.isEmpty(msgLower)) {
      return {
        handled: true,
        response: '¿En qué te puedo ayudar?',
        interactive: this.buildMainMenu(companyType, isWeb),
        action: 'empty',
      };
    }

    if (isWeb) {
      const nav = this.tryNavigate(msgLower);
      if (nav) return nav;
    }

    if (this.isDashboardQuery(msgLower)) {
      return this.getDashboard(user, isWeb);
    }

    const codeOnly = msg.match(/^\s*(F\d{2}-[A-Z]{2,5}\.\d+)\s*$/i);
    if (codeOnly) {
      return this.getFreightQuickStatus(codeOnly[1].toUpperCase(), user, isWeb);
    }

    if (sessionState?.activeContext?.lastFreightCode && this.isStatusQuery(msgLower)) {
      return this.getFreightQuickStatus(sessionState.activeContext.lastFreightCode, user, isWeb);
    }

    if (this.isFleetQuery(msgLower)) {
      return this.getFleetQuickList(user, isWeb);
    }

    return { handled: false };
  }

  private isGreeting(msg: string): boolean {
    return /^(hola|buenas?|buen[oa]s?\s*(d[ií]as?|tardes?|noches?)?|hey|qu[ée]\s*tal|che|epa)\s*[!.,?]*$/i.test(msg);
  }

  private isGoodbye(msg: string): boolean {
    return /^(chau|adi[oó]s|nos vemos|hasta\s*(luego|pronto|mañana)|bye|listo\s*gracias?|gracias\s*chau)\s*[!.]*$/i.test(msg);
  }

  private isThanks(msg: string): boolean {
    return /^(gracias|gracia|genial|perfecto|buenísimo|excelente|joya|10|diez|dale\s*gracias)\s*[!.]*$/i.test(msg);
  }

  private isEmpty(msg: string): boolean {
    return msg.length === 0 || /^[\s\p{Emoji}\p{Emoji_Presentation}\u200d\ufe0f]+$/u.test(msg);
  }

  private isDashboardQuery(msg: string): boolean {
    return /^(mis fletes|dashboard|resumen|qu[eé] tengo|fletes|ver fletes|dame resumen|mostrame mis fletes|listar fletes|listado|listame)\s*[?!.]*$/i.test(msg);
  }

  private isStatusQuery(msg: string): boolean {
    return /^(estado|c[oó]mo va|qu[eé] pas[oó]|novedades|update|cómo está|en qu[eé] va|progreso|avance)\s*[?!.]*$/i.test(msg);
  }

  private isFleetQuery(msg: string): boolean {
    return /^(mis camiones|mi flota|camiones|mis veh[ií]culos|flota|mis chatas)\s*[?!.]*$/i.test(msg);
  }

  private async getDashboard(user: any, isWeb: boolean): Promise<InterceptResult> {
    const activeCoId = user.activeCompanyId || user.companyId;
    try {
      const freights = await this.prisma.freight.findMany({
        where: { participantCompanyIds: { has: activeCoId }, status: { notIn: ['canceled', 'draft', 'finished'] } },
        select: { code: true, status: true, destName: true, items: { select: { grain: true, tons: true }, take: 1 } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      });

      if (freights.length === 0) {
        return { handled: true, response: 'No tenés fletes activos en este momento.', navigate: isWeb ? { screen: 'list' } : undefined, action: 'dashboard_empty' };
      }

      const lines = freights.map(f => {
        const status = FREIGHT_STATUS_SHORT[f.status] || f.status;
        const grain = f.items[0]?.grain || '-';
        const tons = f.items[0]?.tons || '-';
        return `🚛 ${f.code} · ${grain} ${tons}t → ${f.destName} · ${status}`;
      });

      return { handled: true, response: `Tus fletes activos:\n\n${lines.join('\n')}`, navigate: isWeb ? { screen: 'list' } : undefined, action: 'dashboard' };
    } catch (e: any) {
      this.logger.warn(`Dashboard query failed: ${e.message}`);
      return { handled: false };
    }
  }

  private async getFreightQuickStatus(code: string, user: any, isWeb: boolean): Promise<InterceptResult> {
    try {
      const freight = await this.prisma.freight.findFirst({
        where: { code, participantCompanyIds: { has: user.activeCompanyId || user.companyId } },
        select: { id: true, code: true, status: true, destName: true, originName: true, items: { select: { grain: true, tons: true }, take: 1 } },
      });
      if (!freight) return { handled: false };

      const status = FREIGHT_STATUS_SHORT[freight.status] || freight.status;
      const grain = freight.items[0]?.grain || '-';
      const tons = freight.items[0]?.tons || '-';
      return {
        handled: true,
        response: `🚛 ${freight.code}\n${grain} ${tons}t\n${freight.originName} → ${freight.destName}\nEstado: ${status}`,
        navigate: isWeb ? { screen: 'detail', params: { freightId: freight.id } } : undefined,
        action: 'freight_status',
      };
    } catch {
      return { handled: false };
    }
  }

  private async getFleetQuickList(user: any, isWeb: boolean): Promise<InterceptResult> {
    const companyId = user.activeCompanyId || user.companyId;
    try {
      const trucks = await this.prisma.truck.findMany({
        where: { companyId, active: true },
        select: { plate: true, model: true, assignedUser: { select: { name: true } } },
        take: 10,
      });
      if (trucks.length === 0) {
        return { handled: true, response: 'No tenés camiones registrados.', navigate: isWeb ? { screen: 'trucks' } : undefined, action: 'fleet_empty' };
      }
      const lines = trucks.map((t: any) => `🚛 ${t.plate}${t.model ? ` · ${t.model}` : ''}${t.assignedUser?.name ? ` · ${t.assignedUser.name}` : ''}`);
      return { handled: true, response: `Tu flota:\n\n${lines.join('\n')}`, navigate: isWeb ? { screen: 'trucks' } : undefined, action: 'fleet_list' };
    } catch {
      return { handled: false };
    }
  }

  private handleButton(buttonId: string, isWeb: boolean): InterceptResult {
    if (buttonId === 'menu_mi_flota' && isWeb) {
      return { handled: true, response: 'Te llevo a tu flota.', navigate: { screen: 'trucks' }, action: 'button_fleet' };
    }
    return { handled: false };
  }

  private tryNavigate(msg: string): InterceptResult | null {
    const navMap: Record<string, { screen: string; text: string }> = {
      'calendario': { screen: 'calendar', text: 'Te llevo al calendario.' },
      'mapa': { screen: 'locations', text: 'Te llevo al mapa.' },
      'documentos': { screen: 'documents', text: 'Te llevo a documentos.' },
      'mi flota': { screen: 'trucks', text: 'Te llevo a tu flota.' },
      'mis camiones': { screen: 'trucks', text: 'Te llevo a tu flota.' },
      'camiones': { screen: 'trucks', text: 'Te llevo a tu flota.' },
      'notificaciones': { screen: 'notifs', text: 'Te llevo a notificaciones.' },
      'mis datos': { screen: 'mydata', text: 'Te llevo a tus datos.' },
      'estadísticas': { screen: 'analytics', text: 'Te llevo a estadísticas.' },
      'inicio': { screen: 'home', text: 'Te llevo al inicio.' },
      'home': { screen: 'home', text: 'Te llevo al inicio.' },
    };
    const clean = msg.replace(/[?!.]+$/, '').trim();
    const nav = navMap[clean];
    if (nav) return { handled: true, response: nav.text, navigate: { screen: nav.screen }, action: `navigate:${nav.screen}` };
    return null;
  }

  private buildMainMenu(companyType: string, isWeb: boolean): any {
    const options: Array<{ id: string; title: string }> = [{ id: 'menu_mis_fletes', title: 'Mis fletes' }];
    if (companyType.includes('producer') || companyType.includes('plant')) {
      options.push({ id: 'menu_nuevo_flete', title: 'Nuevo flete' });
    }
    if (companyType.includes('transporter') || companyType.includes('producer')) {
      options.push({ id: 'menu_mi_flota', title: 'Mi flota' });
    }
    if (!isWeb) {
      return { type: 'button', body: { text: '¿Qué necesitás?' }, action: { buttons: options.slice(0, 3).map(o => ({ type: 'reply', reply: { id: o.id, title: o.title } })) } };
    }
    return { type: 'quick_replies', options };
  }
}

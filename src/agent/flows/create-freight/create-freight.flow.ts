import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { PrismaService } from '../../../database/prisma.service';
import { UserContextService } from '../../tools/context/user-context.service';
import { CreateFreightTool } from '../../tools/fletes/create-freight.tool';
import { AgentReply } from '../../whatsapp/agent-handler.service';
import { UserContext } from '../../tools/context/user-context.service';
import { CreateFreightState, CreateFreightSlots, CreateFreightStep } from './create-freight.types';

@Injectable()
export class CreateFreightFlow {
  private readonly logger = new Logger(CreateFreightFlow.name);

  constructor(
    private llm: LlmService,
    private prisma: PrismaService,
    private userContext: UserContextService,
    private createFreightTool: CreateFreightTool,
  ) {}

  /**
   * Main handler for create-freight flow state machine.
   */
  async handle(
    phone: string,
    type: string,
    payload: any,
    state: CreateFreightState,
    userCtx: UserContext,
  ): Promise<{ reply: AgentReply; nextState: CreateFreightState }> {
    try {
      switch (state.step) {
        case 'selecting_company':
          return this.handleSelectingCompany(type, payload, state, userCtx);

        case 'opening':
          return this.handleOpening(state, userCtx);

        case 'collecting':
          return this.handleCollecting(type, payload, state, userCtx);

        case 'origin':
          return this.handleOrigin(phone, type, payload, state, userCtx);

        case 'confirming':
          return this.handleConfirming(type, payload, state, userCtx);

        default:
          return {
            reply: { type: 'text', text: 'Algo salió mal en el flujo. Intentá de nuevo.' },
            nextState: { step: 'opening', slots: {} },
          };
      }
    } catch (error) {
      this.logger.error(`Error in create-freight flow: ${error instanceof Error ? error.message : String(error)}`);
      return {
        reply: { type: 'text', text: 'Tuve un problema procesando tu solicitud. Intentá de nuevo.' },
        nextState: state,
      };
    }
  }

  /**
   * Step: selecting_company → show user's active companies as button options
   */
  private async handleSelectingCompany(
    type: string,
    payload: any,
    state: CreateFreightState,
    userCtx: UserContext,
  ): Promise<{ reply: AgentReply; nextState: CreateFreightState }> {
    // First time in this step: show company options
    if (state.meta?.companyPromptShown !== true) {
      const memberships = await this.prisma.user.findUnique({
        where: { id: userCtx.userId },
        select: {
          memberships: {
            where: { active: true },
            select: { companyId: true, company: { select: { id: true, name: true } } },
          },
        },
      });

      const companies = memberships?.memberships?.map((m) => ({ id: m.companyId, name: m.company.name })) || [];

      if (companies.length === 0) {
        return {
          reply: { type: 'text', text: 'No tenés empresas activas. Contactá a administración.' },
          nextState: state,
        };
      }

      if (companies.length === 1) {
        // Single company: auto-select
        const merged = { ...state.slots, companyId: companies[0].id };
        return {
          reply: { type: 'text', text: `Usando tu empresa: ${companies[0].name}` },
          nextState: { ...state, step: 'opening', slots: merged, meta: { companyPromptShown: false } },
        };
      }

      // Multiple companies: show buttons
      const buttons = companies.map((c) => ({
        id: `company:${c.id}`,
        title: c.name.slice(0, 25),
      }));

      return {
        reply: { type: 'buttons', text: '¿Cuál es tu empresa?', buttons },
        nextState: { ...state, meta: { companyPromptShown: true } },
      };
    }

    // User selected a company
    if (type === 'button_reply') {
      const btnId = payload.id;
      if (btnId.startsWith('company:')) {
        const companyId = btnId.slice(8);
        const merged = { ...state.slots, companyId };
        return {
          reply: { type: 'text', text: 'Perfecto. Ahora vamos con el flete.' },
          nextState: { ...state, step: 'opening', slots: merged, meta: { companyPromptShown: false } },
        };
      }
    }

    // If we're waiting for company selection and user sent text
    if (type === 'text') {
      return {
        reply: { type: 'text', text: 'Seleccioná tu empresa con los botones.' },
        nextState: state,
      };
    }

    return {
      reply: { type: 'text', text: '¿Cuál es tu empresa?' },
      nextState: state,
    };
  }

  /**
   * Step: opening → transition to collecting with opening message
   */
  private handleOpening(state: CreateFreightState, userCtx: UserContext): { reply: AgentReply; nextState: CreateFreightState } {
    const openingMsg = `¡Vamos con el flete! Contame:
📦 Producto (ej: soja, maíz, trigo)
🚚 Cantidad de camiones (ej: 3 camiones)
📅 Fecha y hora de carga
🏭 Destino

Cuanto más detalle me des, menos te pregunto 😉`;

    return {
      reply: { type: 'text', text: openingMsg },
      nextState: { ...state, step: 'collecting' },
    };
  }

  /**
   * Step: collecting → extract grain/tons/date/time/dest from message
   */
  private async handleCollecting(
    type: string,
    payload: any,
    state: CreateFreightState,
    userCtx: UserContext,
  ): Promise<{ reply: AgentReply; nextState: CreateFreightState }> {
    if (type !== 'text') {
      return {
        reply: { type: 'text', text: 'Escribí el detalle del flete en texto, por favor.' },
        nextState: state,
      };
    }

    // Extract slots using Haiku
    const extracted = await this.extractSlots(payload.body);
    const merged = { ...state.slots, ...extracted };

    // Required: producto, camiones, fecha, hora, destino. Cantidad (tons) es opcional.
    const missing: string[] = [];
    if (!merged.grain) missing.push('producto');
    if (!merged.truckCount) missing.push('cantidad de camiones');
    if (!merged.loadDate) missing.push('fecha de carga');
    if (!merged.loadTime) missing.push('hora de carga');
    if (!merged.destName) missing.push('destino');

    // If all required fields present → move to origin
    if (missing.length === 0) {
      return {
        reply: { type: 'text', text: 'Perfecto. Ahora necesito saber desde dónde sale.' },
        nextState: { ...state, step: 'origin', slots: merged },
      };
    }

    // Missing some fields → ask for them
    const missingText = missing.map((f, i) => `${i + 1}. ${f}`).join('\n');
    const askMsg = `Casi listo! Faltaría:\n${missingText}\n\n¿Me decís esos datos?`;

    return {
      reply: { type: 'text', text: askMsg },
      nextState: { ...state, step: 'collecting', slots: merged },
    };
  }

  /**
   * Step: origin → ask user to select field or share location
   */
  private async handleOrigin(
    phone: string,
    type: string,
    payload: any,
    state: CreateFreightState,
    userCtx: UserContext,
  ): Promise<{ reply: AgentReply; nextState: CreateFreightState }> {
    // Check if we need to show fields on entry to this step
    if (state.meta?.originPromptShown !== true) {
      // First time in origin step → show field selection or ask for GPS
      const fields = await this.prisma.field.findMany({
        where: { companyId: state.slots.companyId, active: true },
        select: { id: true, name: true },
        take: 3,
      });

      if (fields.length > 0) {
        // Show fields as buttons
        const buttons = [
          ...fields.map((f) => ({ id: `field:${f.id}`, title: f.name.slice(0, 20) })),
          { id: 'gps', title: '📍 Otra ubicación' },
        ];

        return {
          reply: { type: 'buttons', text: '¿Desde dónde sale el flete?', buttons },
          nextState: { ...state, meta: { originPromptShown: true } },
        };
      } else {
        // No fields → ask for location
        const msg = '¿Desde dónde sale el flete?\nCompartí tu ubicación 📍 (clip → Ubicación)';
        return {
          reply: { type: 'text', text: msg },
          nextState: { ...state, meta: { originPromptShown: true } },
        };
      }
    }

    // User responded to origin prompt
    if (type === 'button_reply') {
      const btnId = payload.id;

      if (btnId.startsWith('field:')) {
        const fieldId = btnId.slice(6);
        const field = await this.prisma.field.findUnique({ where: { id: fieldId }, select: { name: true } });
        if (!field) {
          return {
            reply: { type: 'text', text: 'No encontré ese campo. Intentá de nuevo.' },
            nextState: state,
          };
        }

        const merged = { ...state.slots, originFieldId: fieldId, originName: field.name };
        return {
          reply: { type: 'text', text: 'Excelente. Vamos a confirmar.' },
          nextState: { ...state, step: 'confirming', slots: merged },
        };
      }

      if (btnId === 'gps') {
        const msg = 'Perfecto. Compartí tu ubicación exacta 📍\n(Tocá el clip 📎 → Ubicación)';
        return {
          reply: { type: 'text', text: msg },
          nextState: state,
        };
      }
    }

    if (type === 'location') {
      const lat = payload.latitude;
      const lng = payload.longitude;
      if (lat !== undefined && lng !== undefined) {
        const merged = { ...state.slots, originLat: lat, originLng: lng, originName: 'Ubicación compartida' };
        return {
          reply: { type: 'text', text: 'Gracias. Ahora confirmemos todos los datos.' },
          nextState: { ...state, step: 'confirming', slots: merged },
        };
      }
    }

    // If we're waiting for GPS and user sent text → re-prompt
    if (type === 'text' && state.meta?.originPromptShown) {
      const msg = 'Necesito tu ubicación exacta 📍\nTocá el clip 📎 y elegí "Ubicación"';
      return {
        reply: { type: 'text', text: msg },
        nextState: state,
      };
    }

    return {
      reply: { type: 'text', text: 'No entendí. Compartí tu ubicación o seleccioná un campo.' },
      nextState: state,
    };
  }

  /**
   * Step: confirming → show summary + wait for confirm/cancel
   */
  private async handleConfirming(
    type: string,
    payload: any,
    state: CreateFreightState,
    userCtx: UserContext,
  ): Promise<{ reply: AgentReply; nextState: CreateFreightState }> {
    // Show confirmation on entry or if user asked to re-confirm
    if (state.meta?.confirmPromptShown !== true) {
      const summary = this.buildConfirmationMessage(state.slots);

      const buttons = [
        { id: 'confirm', title: '✅ Confirmar' },
        { id: 'cancel', title: '❌ Cancelar' },
      ];

      return {
        reply: { type: 'buttons', text: summary, buttons },
        nextState: { ...state, meta: { confirmPromptShown: true } },
      };
    }

    // User clicked a button
    if (type === 'button_reply') {
      if (payload.id === 'confirm') {
        // Create the freight
        const result = await this.createFreightTool.execute(userCtx, state.slots);
        const msg = `✅ Flete *${result.code}* creado.
Lo estamos coordinando con el transportista.`;
        return {
          reply: { type: 'text', text: msg },
          nextState: { ...state, step: 'confirming' }, // Done, but stay in confirming
        };
      }

      if (payload.id === 'cancel') {
        const msg = 'Cancelado. Avisá cuando quieras crear otro flete.';
        return {
          reply: { type: 'text', text: msg },
          nextState: { ...state, step: 'confirming' }, // Done
        };
      }
    }

    // If user sent text instead of clicking → re-show buttons
    if (type === 'text') {
      const summary = this.buildConfirmationMessage(state.slots);
      const buttons = [
        { id: 'confirm', title: '✅ Confirmar' },
        { id: 'cancel', title: '❌ Cancelar' },
      ];
      return {
        reply: { type: 'buttons', text: summary, buttons },
        nextState: state,
      };
    }

    return {
      reply: { type: 'text', text: '¿Confirmamos el flete?' },
      nextState: state,
    };
  }

  /**
   * Extract slots from free-text message using Claude Haiku.
   */
  private async extractSlots(message: string): Promise<Partial<CreateFreightSlots>> {
    const today = this.formatDateISO(new Date());
    const tomorrow = this.formatDateISO(new Date(Date.now() + 24 * 60 * 60 * 1000));

    const extractPrompt = `Sos un extractor de datos de fletes agropecuarios (Argentina).
Del mensaje del usuario, extraé SÓLO estos campos:
- grain: producto/carga (ej: soja, maíz, trigo, cebada, sorgo, colza, arroz, fertilizante, etc.)
- tons: cantidad en toneladas si la menciona (sólo número, opcional)
- truckCount: cantidad de camiones (sólo número entero, ej: "3 camiones" → 3, "un camión" → 1)
- loadDate: fecha de carga en formato YYYY-MM-DD. Hoy = ${today}, mañana = ${tomorrow}. Acepta "15/06", "15 de junio", "el lunes", etc.
- loadTime: hora de carga en formato HH:MM 24h (ej: 08:00, 14:30)
- destName: nombre del destino (planta, puerto, lugar)

No inventes datos. Para campos no mencionados usá null.
Respondé SÓLO con JSON válido, sin texto adicional.
Ejemplo: {"grain":"soja","tons":200,"truckCount":3,"loadDate":"2025-06-15","loadTime":"08:00","destName":"Planta ACA"}`;

    try {
      const response = await this.llm.chat(
        extractPrompt,
        [{ role: 'user', content: message }],
        { model: 'haiku' },
      );

      const json = JSON.parse(response);
      const slots: Partial<CreateFreightSlots> = {};

      if (json.grain) slots.grain = String(json.grain);
      if (json.tons) slots.tons = Number(json.tons);
      if (json.truckCount) slots.truckCount = Number(json.truckCount);
      if (json.loadDate) slots.loadDate = String(json.loadDate);
      if (json.loadTime) slots.loadTime = String(json.loadTime);
      if (json.destName) slots.destName = String(json.destName);

      this.logger.debug(`Extracted slots: ${JSON.stringify(slots)}`);
      return slots;
    } catch (error) {
      this.logger.warn(`Slot extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  /**
   * Build confirmation message from slots.
   */
  private buildConfirmationMessage(slots: CreateFreightSlots): string {
    let msg = '*Resumen del flete:*\n';

    if (slots.grain) {
      msg += `📦 ${slots.grain}${slots.tons ? ` — ${slots.tons} tn` : ''}\n`;
    }

    if (slots.truckCount) {
      msg += `🚚 ${slots.truckCount} ${slots.truckCount === 1 ? 'camión' : 'camiones'}\n`;
    }

    if (slots.loadDate && slots.loadTime) {
      const dateStr = this.formatDate(slots.loadDate);
      msg += `📅 ${dateStr}, ${slots.loadTime}\n`;
    }

    if (slots.originName) {
      msg += `📍 Desde: ${slots.originName}\n`;
    }

    if (slots.destName) {
      msg += `🏭 Hasta: ${slots.destName}\n`;
    }

    msg += '\n¿Confirmamos?';
    return msg;
  }

  private formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr + 'T00:00:00');
      const day = date.getDate();
      const month = [
        'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
        'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
      ][date.getMonth()];
      return `${day} de ${month}`;
    } catch {
      return dateStr;
    }
  }

  private formatDateISO(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

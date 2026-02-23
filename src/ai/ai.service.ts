// =====================================================================
// TOLVINK — AI Service (Claude / Anthropic)
// Conversational assistant for WhatsApp with tool use
// =====================================================================

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FreightsService } from '../freights/freights.service';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';
import { AdminService } from '../admin/admin.controller';
import Anthropic from '@anthropic-ai/sdk';

const MAX_HISTORY = 40;
const MAX_TOOL_LOOPS = 5;
const AI_SESSION_TIMEOUT_MIN = 30;
const APP_URL = 'https://tolvink.vercel.app';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => FreightsService)) private freights: FreightsService,
    private fieldsService: FieldsService,
    private trucksService: TrucksService,
    private adminService: AdminService,
  ) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log('Claude AI assistant enabled (haiku)');
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI assistant disabled');
    }
  }

  isEnabled(): boolean {
    return !!this.client;
  }

  // ======================== MAIN CHAT METHOD =============================

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
  ): Promise<string> {
    if (!this.client) {
      return 'El asistente IA no esta disponible en este momento.';
    }

    const synUser = this.buildSyntheticUser(user);
    const companyType = this.resolveCompanyType(user);
    const systemPrompt = this.buildSystemPrompt(user, companyType);

    // Load conversation history from session
    const state = (session?.flowState as any) || {};
    const aiMessages: any[] = state.aiMessages || [];

    // Add user message
    aiMessages.push({ role: 'user', content: userMessage });

    // Trim to last N messages
    const trimmed = aiMessages.slice(-MAX_HISTORY);

    let response: any;
    let loopCount = 0;
    const currentMessages = [...trimmed];

    try {
      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;

        console.log(`[AI] Sending to Claude (loop ${loopCount}), messages: ${currentMessages.length}`);
        response = await this.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          tools: this.tools as any,
          messages: currentMessages,
        });
        console.log(`[AI] Claude response: stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);

        if (response.stop_reason === 'tool_use') {
          // Add assistant response to messages
          currentMessages.push({ role: 'assistant', content: response.content });

          // Execute tool calls
          const toolResults: any[] = [];
          for (const block of response.content) {
            if (block.type === 'tool_use') {
              this.logger.log(`AI tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
              const result = await this.executeTool(block.name, block.input, user, synUser, session);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              });
            }
          }

          currentMessages.push({ role: 'user', content: toolResults });
        } else {
          break;
        }
      }

      // Extract text response
      const textBlocks = response.content.filter((b: any) => b.type === 'text');
      const finalText = textBlocks.map((b: any) => b.text).join('\n') || 'No pude procesar tu mensaje.';

      // Save updated history — reload session first to preserve tool-written state (e.g. pendingFreight)
      currentMessages.push({ role: 'assistant', content: response.content });

      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          flowState: {
            ...latestState,
            aiMessages: currentMessages.slice(-MAX_HISTORY),
          },
          expiresAt: new Date(Date.now() + AI_SESSION_TIMEOUT_MIN * 60 * 1000),
        },
      });

      return finalText;
    } catch (e) {
      console.error(`[AI] Chat error:`, e.message, e.stack?.slice(0, 300));
      this.logger.error(`AI chat error: ${e.message}`);
      return 'Estoy teniendo problemas tecnicos. Intenta de nuevo o usa los botones del menu.';
    }
  }

  // ======================== SYSTEM PROMPT ================================

  private buildSystemPrompt(user: any, companyType: string): string {
    const name = user.name?.split(' ')[0] || 'usuario';
    const today = new Date().toISOString().split('T')[0];

    return `Sos Tolvink, asistente virtual de gestion de fletes de granos por WhatsApp.
Hablas español rioplatense (vos, sos, tenes). Se conciso — esto es WhatsApp.
Usa emojis con moderacion. No uses markdown de enlaces.

USUARIO: ${name} | Empresa: ${companyType} | Hoy: ${today}

ESTADOS DE UN FLETE:
pending_assignment → assigned → accepted → in_progress → loaded → finished (o canceled)

REGLAS:
- Solo productores pueden crear fletes
- Solo transportistas/choferes: aceptar, rechazar, iniciar viaje, confirmar carga/entrega
- Rechazar o cancelar requiere motivo
- No se puede cancelar si esta in_progress o loaded
- Confirmar carga requiere toneladas reales

GRANOS: Soja, Maiz, Trigo, Girasol, Sorgo, Cebada, Otros

INSTRUCCIONES CRITICAS PARA CREAR FLETES:
1. Primero usa search_plants y list_lots (o list_fields) para resolver IDs si es posible.
2. Llama prepare_freight con los datos. Esto NO crea el flete, solo lo prepara.
3. Mostra el resumen al usuario y pregunta "¿Confirmás?"
4. Cuando el usuario diga "si", "dale", "confirmar", "ok" o similar, DEBES llamar la herramienta confirm_create_freight. NUNCA digas que el flete fue creado sin llamar a confirm_create_freight. El flete NO existe hasta que llames esa herramienta.
5. Si falta info, pregunta solo lo que falta. NO inventes datos.

FLOTA PROPIA:
- Si el productor quiere usar su propia flota, usa list_trucks para mostrar camiones disponibles.
- Incluí truckId en prepare_freight para asignar flota propia al flete.

UBICACIONES DE WHATSAPP:
- Si el usuario comparte una ubicacion de WhatsApp, se guarda automaticamente en la sesion.
- Podes usarla para asignar coordenadas a campos, lotes, u origenes/destinos de flete.
- La ubicacion se usa automaticamente si no se proporcionan lat/lng en create_field, create_lot, o prepare_freight.

CAMPOS, LOTES Y CAMIONES:
- Usa list_fields para ver campos y lotes existentes con sus IDs.
- Podes crear campos con create_field y lotes con create_lot.
- Podes registrar camiones con create_truck.

USUARIOS:
- Solo admin/gerente puede crear usuarios con create_user.
- Si el usuario no es admin, explica que necesita permisos.

OTRAS INSTRUCCIONES:
- Nunca expongas UUIDs. Usa codigos FLT-XXXX.
- Si hay error, traducilo a lenguaje amigable.
- Link de la app: ${APP_URL}`;
  }

  // ======================== TOOL DEFINITIONS =============================

  private readonly tools = [
    {
      name: 'list_freights',
      description: 'Lista los fletes del usuario. Puede filtrar por estado.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
            description: 'Filtrar por estado (opcional)',
          },
          limit: { type: 'number', description: 'Cantidad maxima (default 10)' },
        },
        required: [],
      },
    },
    {
      name: 'get_freight_detail',
      description: 'Detalle completo de un flete por codigo FLT-XXXX.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: FLT-0001' },
        },
        required: ['code'],
      },
    },
    {
      name: 'search_plants',
      description: 'Busca plantas/empresas destino disponibles para el productor por nombre.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Nombre parcial de la planta' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_lots',
      description: 'Lista los lotes/campos de origen del productor.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'prepare_freight',
      description: 'Prepara un flete para creacion (NO lo crea). Devuelve resumen para confirmar. Necesita: grain, tons, destPlantId o destName, loadDate (YYYY-MM-DD), loadTime (HH:mm). Opcional: originLotId, customOriginName, customOriginLat/Lng, truckId (flota propia), truckCount, notes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          grain: { type: 'string', enum: ['Soja', 'Maiz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'] },
          tons: { type: 'number' },
          truckCount: { type: 'number', description: 'Default 1' },
          destPlantId: { type: 'string', description: 'ID de planta (de search_plants)' },
          destName: { type: 'string', description: 'Nombre destino si no hay planta' },
          customDestLat: { type: 'number', description: 'Latitud destino personalizado (de ubicacion WhatsApp)' },
          customDestLng: { type: 'number', description: 'Longitud destino personalizado (de ubicacion WhatsApp)' },
          originLotId: { type: 'string', description: 'ID de lote (de list_lots o list_fields)' },
          customOriginName: { type: 'string', description: 'Nombre origen si no hay lote' },
          customOriginLat: { type: 'number', description: 'Latitud origen personalizado (de ubicacion WhatsApp)' },
          customOriginLng: { type: 'number', description: 'Longitud origen personalizado (de ubicacion WhatsApp)' },
          truckId: { type: 'string', description: 'ID de camion propio (de list_trucks) para asignar flota propia' },
          loadDate: { type: 'string', description: 'YYYY-MM-DD' },
          loadTime: { type: 'string', description: 'HH:mm' },
          notes: { type: 'string' },
        },
        required: ['grain', 'tons', 'loadDate', 'loadTime'],
      },
    },
    {
      name: 'confirm_create_freight',
      description: 'OBLIGATORIO: Crea el flete preparado con prepare_freight. Debes llamar esta herramienta cuando el usuario confirme (dice si/dale/confirmar/ok). Sin esta llamada el flete NO se crea.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'accept_freight',
      description: 'Acepta un flete asignado.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
        },
        required: ['code'],
      },
    },
    {
      name: 'reject_freight',
      description: 'Rechaza un flete asignado. Requiere motivo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
          reason: { type: 'string', description: 'Motivo del rechazo' },
        },
        required: ['code', 'reason'],
      },
    },
    {
      name: 'start_freight',
      description: 'Inicia el viaje de un flete aceptado.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
        },
        required: ['code'],
      },
    },
    {
      name: 'confirm_loaded',
      description: 'Confirma carga de un flete. Requiere toneladas reales.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
          tons: { type: 'number', description: 'Toneladas cargadas' },
        },
        required: ['code', 'tons'],
      },
    },
    {
      name: 'confirm_finished',
      description: 'Confirma entrega/recepcion de un flete.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
        },
        required: ['code'],
      },
    },
    {
      name: 'cancel_freight',
      description: 'Cancela un flete. No se puede si esta in_progress o loaded.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
          reason: { type: 'string', description: 'Motivo de cancelacion' },
        },
        required: ['code', 'reason'],
      },
    },
    // ---- Field & Lot management ----
    {
      name: 'list_fields',
      description: 'Lista todos los campos y lotes del productor con sus coordenadas.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'create_field',
      description: 'Crea un campo (establecimiento). Si el usuario compartio una ubicacion de WhatsApp, se usa automaticamente como lat/lng.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Nombre del campo' },
          address: { type: 'string', description: 'Direccion (opcional)' },
          lat: { type: 'number', description: 'Latitud (opcional, se usa ubicacion compartida si no se indica)' },
          lng: { type: 'number', description: 'Longitud (opcional, se usa ubicacion compartida si no se indica)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'create_lot',
      description: 'Crea un lote dentro de un campo existente. Usa list_fields para obtener el fieldId.',
      input_schema: {
        type: 'object' as const,
        properties: {
          fieldId: { type: 'string', description: 'ID del campo (de list_fields)' },
          name: { type: 'string', description: 'Nombre del lote' },
          hectares: { type: 'number', description: 'Hectareas (opcional)' },
          lat: { type: 'number', description: 'Latitud (opcional, se usa ubicacion compartida si no se indica)' },
          lng: { type: 'number', description: 'Longitud (opcional, se usa ubicacion compartida si no se indica)' },
        },
        required: ['fieldId', 'name'],
      },
    },
    // ---- Truck management ----
    {
      name: 'list_trucks',
      description: 'Lista los camiones/flota de la empresa del usuario.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'create_truck',
      description: 'Registra un nuevo camion en la flota de la empresa.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plate: { type: 'string', description: 'Patente/matricula del camion (ej: ABC1234)' },
          model: { type: 'string', description: 'Modelo del camion (opcional)' },
        },
        required: ['plate'],
      },
    },
    // ---- User management ----
    {
      name: 'create_user',
      description: 'Crea un nuevo usuario en la empresa del usuario actual. Solo admin/gerente puede hacerlo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Nombre completo' },
          email: { type: 'string', description: 'Email del usuario' },
          password: { type: 'string', description: 'Contrasena inicial' },
          phone: { type: 'string', description: 'Telefono (opcional)' },
          role: { type: 'string', enum: ['admin', 'operario', 'chofer'], description: 'Rol: admin, operario, o chofer (default: operario)' },
        },
        required: ['name', 'email', 'password'],
      },
    },
  ];

  // ======================== TOOL EXECUTION ===============================

  private async executeTool(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
  ): Promise<string> {
    try {
      switch (toolName) {
        case 'list_freights': return await this.toolListFreights(synUser, input);
        case 'get_freight_detail': return await this.toolGetFreightDetail(input);
        case 'search_plants': return await this.toolSearchPlants(user);
        case 'list_lots': return await this.toolListLots(user);
        case 'prepare_freight': return await this.toolPrepareFreight(input, user, session);
        case 'confirm_create_freight': return await this.toolConfirmCreateFreight(user, synUser, session);
        case 'accept_freight': return await this.toolAcceptFreight(input, synUser);
        case 'reject_freight': return await this.toolRejectFreight(input, synUser);
        case 'start_freight': return await this.toolStartFreight(input, synUser);
        case 'confirm_loaded': return await this.toolConfirmLoaded(input, synUser);
        case 'confirm_finished': return await this.toolConfirmFinished(input, synUser);
        case 'cancel_freight': return await this.toolCancelFreight(input, synUser);
        case 'list_fields': return await this.toolListFields(user);
        case 'create_field': return await this.toolCreateField(input, user, session);
        case 'create_lot': return await this.toolCreateLot(input, user, session);
        case 'list_trucks': return await this.toolListTrucks(user);
        case 'create_truck': return await this.toolCreateTruck(input, user);
        case 'create_user': return await this.toolCreateUser(input, user);
        default: return JSON.stringify({ error: 'Herramienta no reconocida' });
      }
    } catch (e) {
      this.logger.error(`Tool ${toolName} error: ${e.message}`);
      return JSON.stringify({ error: e.message || 'Error desconocido' });
    }
  }

  // ---- list_freights ----
  private async toolListFreights(synUser: any, input: any): Promise<string> {
    const result = await this.freights.findAll(synUser, {
      status: input.status,
      limit: Math.min(input.limit || 10, 20),
      page: 1,
    } as any);

    if (result.data.length === 0) {
      return JSON.stringify({ total: 0, freights: [], message: 'No hay fletes que coincidan' });
    }

    const freights = result.data.map((f: any) => ({
      code: f.code,
      status: f.status,
      grain: f.items?.[0]?.grain || 'N/A',
      tons: f.items?.[0]?.tons || 0,
      origin: f.originName || f.originCompany?.name || 'N/A',
      dest: f.destName || f.destCompany?.name || 'N/A',
      date: f.loadDate ? new Date(f.loadDate).toISOString().split('T')[0] : 'N/A',
      transporter: f.assignments?.[0]?.transportCompany?.name || 'Sin asignar',
    }));

    return JSON.stringify({ total: result.total, showing: freights.length, freights });
  }

  // ---- get_freight_detail ----
  private async toolGetFreightDetail(input: any): Promise<string> {
    const freight = await this.prisma.freight.findFirst({
      where: { code: input.code.toUpperCase() },
      include: {
        items: true,
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { name: true } },
            driver: { select: { name: true } },
            truck: { select: { plate: true } },
          },
        },
      },
    });

    if (!freight) {
      return JSON.stringify({ error: `No se encontro el flete ${input.code}` });
    }

    const assignment = freight.assignments[0];
    return JSON.stringify({
      code: freight.code,
      status: freight.status,
      items: freight.items.map((i: any) => ({ grain: i.grain, tons: i.tons })),
      origin: (freight as any).originName || freight.originCompany?.name || 'N/A',
      dest: (freight as any).destName || freight.destCompany?.name || 'N/A',
      date: freight.loadDate ? new Date(freight.loadDate).toISOString().split('T')[0] : null,
      time: (freight as any).loadTime || null,
      transporter: assignment?.transportCompany?.name || 'Sin asignar',
      driver: assignment?.driver?.name || null,
      truck: assignment?.truck?.plate || null,
      notes: (freight as any).notes || null,
      link: `${APP_URL}/freights/${freight.id}`,
    });
  }

  // ---- search_plants ----
  private async toolSearchPlants(user: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No sos productor', plants: [] });
    }

    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId, active: true },
      select: { plantCompanyId: true },
    });

    const plantCompanyIds = [...new Set(accessRecords.map(ar => ar.plantCompanyId))];
    if (plantCompanyIds.length === 0) {
      return JSON.stringify({ plants: [], message: 'No tenes plantas habilitadas' });
    }

    const companies = await this.prisma.company.findMany({
      where: { id: { in: plantCompanyIds }, active: true },
      select: { id: true, name: true },
      take: 10,
    });

    const results: any[] = [];
    for (const c of companies) {
      const branches = await this.prisma.plant.findMany({
        where: { companyId: c.id, active: true },
        select: { id: true, name: true, address: true },
      });
      results.push({
        companyId: c.id,
        companyName: c.name,
        branches: branches.map(b => ({ id: b.id, name: b.name })),
      });
    }

    return JSON.stringify({ plants: results });
  }

  // ---- list_lots ----
  private async toolListLots(user: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No sos productor', lots: [] });
    }

    const lots = await this.prisma.lot.findMany({
      where: { companyId: producerCompanyId, active: true },
      include: { field: { select: { id: true, name: true } } },
      take: 20,
    });

    return JSON.stringify({
      lots: lots.map((l: any) => ({
        id: l.id,
        name: l.name,
        field: l.field?.name || null,
      })),
    });
  }

  // ---- prepare_freight ----
  private async toolPrepareFreight(input: any, user: any, session: any): Promise<string> {
    // Resolve display names
    let destDisplayName = input.destName || 'Sin destino';
    if (input.destPlantId) {
      const plant = await this.prisma.plant.findUnique({
        where: { id: input.destPlantId },
        select: { name: true, company: { select: { name: true } } },
      });
      if (plant) {
        destDisplayName = `${plant.company.name} - ${plant.name}`;
      } else {
        const company = await this.prisma.company.findUnique({
          where: { id: input.destPlantId },
          select: { name: true },
        });
        destDisplayName = company?.name || destDisplayName;
      }
    }

    let originDisplayName = input.customOriginName || 'Sin origen';
    if (input.originLotId) {
      const lot = await this.prisma.lot.findUnique({
        where: { id: input.originLotId },
        select: { name: true, field: { select: { name: true } } },
      });
      if (lot) originDisplayName = lot.field?.name ? `${lot.field.name} - ${lot.name}` : lot.name;
    }

    // Resolve truck name if own fleet
    let truckDisplay: string | null = null;
    if (input.truckId) {
      const truck = await this.prisma.truck.findUnique({
        where: { id: input.truckId },
        select: { plate: true, model: true },
      });
      if (truck) truckDisplay = truck.model ? `${truck.plate} (${truck.model})` : truck.plate;
    }

    const dateFormatted = input.loadDate.split('-').reverse().join('/');
    const summary: any = {
      grain: input.grain,
      tons: input.tons,
      truckCount: input.truckCount || 1,
      origin: originDisplayName,
      dest: destDisplayName,
      date: dateFormatted,
      time: input.loadTime,
      notes: input.notes || null,
    };
    if (truckDisplay) summary.truck = truckDisplay;

    // Store pending freight in session
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: { ...state, pendingFreight: input },
      },
    });

    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      IMPORTANT: 'El flete NO fue creado todavia. Mostra el resumen y pregunta al usuario si confirma. Cuando confirme, DEBES llamar la herramienta confirm_create_freight para crearlo.',
    });
  }

  // ---- confirm_create_freight ----
  private async toolConfirmCreateFreight(user: any, synUser: any, session: any): Promise<string> {
    // Reload session from DB to get pendingFreight saved by prepare_freight
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const state = (freshSession?.flowState as any) || {};
    const pending = state.pendingFreight;

    console.log(`[AI] confirm_create_freight — pendingFreight: ${pending ? JSON.stringify(pending).slice(0, 200) : 'NULL'}`);

    if (!pending) {
      return JSON.stringify({ error: 'No hay un flete pendiente de confirmacion. Primero usa prepare_freight.' });
    }

    const producerCompanyId = this.resolveProducerCompanyId(user);
    const producerSynUser = {
      ...synUser,
      companyId: producerCompanyId,
      companyType: 'producer',
      userType: 'producer',
    };

    const dto: any = {
      items: [{ grain: pending.grain, tons: pending.tons }],
      loadDate: pending.loadDate,
      loadTime: pending.loadTime,
      truckCount: pending.truckCount || 1,
      notes: pending.notes,
    };

    if (pending.destPlantId) dto.destPlantId = pending.destPlantId;
    else if (pending.destName) dto.customDestName = pending.destName;

    if (pending.originLotId) {
      dto.originLotId = pending.originLotId;
      // Lookup lot coordinates (fallback to field) so origin location is populated
      const lot = await this.prisma.lot.findUnique({
        where: { id: pending.originLotId },
        select: { lat: true, lng: true, field: { select: { lat: true, lng: true } } },
      });
      if (lot) {
        const lat = lot.lat || lot.field?.lat;
        const lng = lot.lng || lot.field?.lng;
        if (lat && lng) {
          dto.overrideOriginLat = Number(lat);
          dto.overrideOriginLng = Number(lng);
        }
      }
    } else {
      dto.customOriginName = pending.customOriginName || 'Origen WhatsApp';
      if (pending.customOriginLat && pending.customOriginLng) {
        dto.overrideOriginLat = pending.customOriginLat;
        dto.overrideOriginLng = pending.customOriginLng;
      } else {
        dto.overrideOriginLat = -34.0;
        dto.overrideOriginLng = -56.0;
      }
    }

    // Destination coordinates from WhatsApp location
    if (pending.customDestLat && pending.customDestLng) {
      dto.overrideDestLat = pending.customDestLat;
      dto.overrideDestLng = pending.customDestLng;
    }

    // Own fleet truck assignment
    if (pending.truckId) {
      dto.truckId = pending.truckId;
    }

    console.log(`[AI] Creating freight with DTO:`, JSON.stringify(dto).slice(0, 300));
    const freight = await this.freights.create(dto, producerSynUser);
    console.log(`[AI] Freight created: ${(freight as any).code}`);

    // Clear pending freight
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: { ...state, pendingFreight: null },
      },
    });

    return JSON.stringify({
      status: 'created',
      code: (freight as any).code,
      link: `${APP_URL}/freights/${(freight as any).id}`,
    });
  }

  // ---- accept_freight ----
  private async toolAcceptFreight(input: any, synUser: any): Promise<string> {
    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });
    await this.freights.respond(freight.id, { action: 'accepted' } as any, synUser);
    return JSON.stringify({ status: 'accepted', code: freight.code });
  }

  // ---- reject_freight ----
  private async toolRejectFreight(input: any, synUser: any): Promise<string> {
    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });
    await this.freights.respond(freight.id, { action: 'rejected', reason: input.reason } as any, synUser);
    return JSON.stringify({ status: 'rejected', code: freight.code });
  }

  // ---- start_freight ----
  private async toolStartFreight(input: any, synUser: any): Promise<string> {
    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });
    await this.freights.start(freight.id, synUser);
    return JSON.stringify({ status: 'started', code: freight.code });
  }

  // ---- confirm_loaded ----
  private async toolConfirmLoaded(input: any, synUser: any): Promise<string> {
    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });
    await this.freights.confirmLoaded(freight.id, synUser, input.tons);
    return JSON.stringify({ status: 'loaded', code: freight.code, tons: input.tons });
  }

  // ---- confirm_finished ----
  private async toolConfirmFinished(input: any, synUser: any): Promise<string> {
    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });
    await this.freights.confirmFinished(freight.id, synUser);
    return JSON.stringify({ status: 'finished', code: freight.code });
  }

  // ---- cancel_freight ----
  private async toolCancelFreight(input: any, synUser: any): Promise<string> {
    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });
    await this.freights.cancel(freight.id, { reason: input.reason } as any, synUser);
    return JSON.stringify({ status: 'canceled', code: freight.code });
  }

  // ======================== FIELD & LOT TOOLS ===========================

  // ---- list_fields ----
  private async toolListFields(user: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const fields = await this.prisma.field.findMany({
      where: { companyId: producerCompanyId, active: true },
      include: { lots: { where: { active: true } } },
      orderBy: { name: 'asc' },
    });

    if (fields.length === 0) {
      return JSON.stringify({ total: 0, fields: [], message: 'No hay campos registrados. Podes crear uno con create_field.' });
    }

    const result = fields.map((f: any) => ({
      id: f.id,
      name: f.name,
      address: f.address,
      lat: f.lat ? Number(f.lat) : null,
      lng: f.lng ? Number(f.lng) : null,
      lots: f.lots.map((l: any) => ({
        id: l.id,
        name: l.name,
        hectares: l.hectares ? Number(l.hectares) : null,
        lat: l.lat ? Number(l.lat) : null,
        lng: l.lng ? Number(l.lng) : null,
      })),
    }));

    return JSON.stringify({ total: fields.length, fields: result });
  }

  // ---- create_field ----
  private async toolCreateField(input: any, user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };

    // Use lastLocation from WhatsApp if no lat/lng provided
    if (!input.lat || !input.lng) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const state = (freshSession?.flowState as any) || {};
      if (state.lastLocation) {
        input.lat = input.lat || state.lastLocation.lat;
        input.lng = input.lng || state.lastLocation.lng;
      }
    }

    const field = await this.fieldsService.createField(producerSynUser, {
      name: input.name,
      address: input.address || null,
      lat: input.lat || null,
      lng: input.lng || null,
    });

    return JSON.stringify({
      status: 'created',
      field: { id: field.id, name: field.name, lat: field.lat ? Number(field.lat) : null, lng: field.lng ? Number(field.lng) : null },
      message: `Campo "${field.name}" creado. Podes agregar lotes con create_lot usando fieldId: ${field.id}`,
    });
  }

  // ---- create_lot ----
  private async toolCreateLot(input: any, user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };

    // Use lastLocation from WhatsApp if no lat/lng provided
    if (!input.lat || !input.lng) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const state = (freshSession?.flowState as any) || {};
      if (state.lastLocation) {
        input.lat = input.lat || state.lastLocation.lat;
        input.lng = input.lng || state.lastLocation.lng;
      }
    }

    const lot = await this.fieldsService.createLot(producerSynUser, input.fieldId, {
      name: input.name,
      hectares: input.hectares || null,
      lat: input.lat || null,
      lng: input.lng || null,
    });

    return JSON.stringify({
      status: 'created',
      lot: { id: lot.id, name: lot.name, fieldId: input.fieldId, hectares: lot.hectares ? Number(lot.hectares) : null },
      message: `Lote "${lot.name}" creado en el campo.`,
    });
  }

  // ======================== TRUCK TOOLS ==================================

  // ---- list_trucks ----
  private async toolListTrucks(user: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const trucks = await this.trucksService.list(synUser);

    if ((trucks as any[]).length === 0) {
      return JSON.stringify({ total: 0, trucks: [], message: 'No hay camiones registrados. Podes crear uno con create_truck.' });
    }

    const result = (trucks as any[]).map((t: any) => ({
      id: t.id,
      plate: t.plate,
      model: t.model,
      driver: t.assignedUser ? t.assignedUser.name : null,
    }));

    return JSON.stringify({ total: result.length, trucks: result });
  }

  // ---- create_truck ----
  private async toolCreateTruck(input: any, user: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const truck = await this.trucksService.create(
      { plate: input.plate, model: input.model || null } as any,
      synUser,
    );

    return JSON.stringify({
      status: 'created',
      truck: { id: (truck as any).id, plate: (truck as any).plate, model: (truck as any).model },
      message: `Camion ${(truck as any).plate} registrado.`,
    });
  }

  // ======================== USER TOOLS ===================================

  // ---- create_user ----
  private async toolCreateUser(input: any, user: any): Promise<string> {
    // Check that requesting user is admin/gerente
    const userRole = user.role || '';
    const memberRoles = user.memberships?.map((m: any) => m.role) || [];
    const allRoles = [userRole, ...memberRoles];
    const isAdmin = allRoles.some((r: string) => ['admin', 'gerente', 'platform_admin'].includes(r)) || user.isSuperAdmin;

    if (!isAdmin) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden crear usuarios.' });
    }

    const producerCompanyId = this.resolveProducerCompanyId(user);
    const companyType = this.resolveCompanyType(user);
    const primaryType = companyType.split(',')[0]?.trim() || 'producer';

    const role = input.role || 'operario';
    const dto: any = {
      name: input.name,
      email: input.email,
      password: input.password,
      phone: input.phone || null,
      role,
      companyId: producerCompanyId,
      userTypes: [primaryType],
      companyByType: { [primaryType]: producerCompanyId },
      roleByType: { [primaryType]: role },
    };

    const newUser = await this.adminService.createUser(dto);
    return JSON.stringify({
      status: 'created',
      user: { id: (newUser as any).id, name: (newUser as any).name, email: (newUser as any).email, role },
      message: `Usuario "${input.name}" creado con rol ${role}.`,
    });
  }

  // ======================== HELPERS =====================================

  private async resolveFreight(code: string): Promise<any | null> {
    return this.prisma.freight.findFirst({
      where: { code: code.toUpperCase() },
      select: { id: true, code: true, status: true },
    });
  }

  private resolveCompanyType(user: any): string {
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    if (userTypes.length > 0) return userTypes.join(', ');
    if (user.company?.type) return user.company.type;
    if (user.memberships?.length > 0) {
      const types = user.memberships
        .map((m: any) => m.company?.type)
        .filter(Boolean);
      return types.join(', ') || 'unknown';
    }
    return 'unknown';
  }

  private resolveProducerCompanyId(user: any): string | null {
    if (user.memberships?.length > 0) {
      const pm = user.memberships.find((m: any) =>
        m.company?.type === 'producer' ||
        (Array.isArray(m.company?.types) && m.company.types.includes('producer')),
      );
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('producer') && companyByType.producer) {
      return companyByType.producer;
    }
    if (user.company?.type === 'producer') return user.companyId;
    return user.activeCompanyId || user.companyId || null;
  }

  private buildSyntheticUser(dbUser: any): any {
    const companyByType = (dbUser.companyByType as any) || {};
    const userTypes = Array.isArray(dbUser.userTypes) ? dbUser.userTypes : [];
    let companyType = 'unknown';
    let companyId = dbUser.activeCompanyId || dbUser.companyId || '';
    if (userTypes.length > 0) {
      companyType = userTypes[0];
    } else if (dbUser.company?.type) {
      companyType = dbUser.company.type;
    } else if (dbUser.memberships?.length > 0) {
      const first = dbUser.memberships[0];
      const types = Array.isArray(first.company?.types) && first.company.types.length > 0
        ? first.company.types : [first.company?.type];
      companyType = types[0] || 'unknown';
      companyId = companyId || first.companyId;
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

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

const MAX_HISTORY = 30;           // Tighter context for focused responses
const MAX_TOOL_LOOPS = 5;
const AI_SESSION_TIMEOUT_MIN = 30;
const APP_URL = 'https://tolvink.vercel.app';

// Model configuration — Claude Haiku 4.5
// NOTE: Anthropic API supports temperature, top_p, top_k.
// It does NOT support presence_penalty / frequency_penalty (those are OpenAI-only).
// temperature 0.3  → precise, factual responses; not 0 to preserve natural language.
// max_tokens 800   → enforces WhatsApp-friendly length (~600 chars español).
const MODEL_TEMPERATURE = 0.3;
const MODEL_MAX_TOKENS = 800;
const MAX_RESPONSE_CHARS = 1500;   // Hard cap before truncation
const STALE_SESSION_MIN = 10;      // Minutes gap that triggers context reminder

// Audio filler words common in River Plate Spanish voice transcriptions
const AUDIO_FILLERS = /\b(eh+|ehmm*|emm*|mmm*|a+h+|este+|o sea|digamos|nada|viste|tipo|bue+no|dale|claro)\b[,.]?\s*/gi;

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
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> }> {
    if (!this.client) {
      return { text: 'El asistente IA no esta disponible en este momento.' };
    }

    const synUser = this.buildSyntheticUser(user);
    const companyType = this.resolveCompanyType(user);
    const systemPrompt = this.buildSystemPrompt(user, companyType);

    // Preprocess: clean audio fillers, normalize whitespace
    const cleanedMessage = this.preprocessMessage(userMessage);

    // Load conversation history from session
    const state = (session?.flowState as any) || {};
    const aiMessages: any[] = state.aiMessages || [];

    // Stale session detection: inject context note if conversation paused
    let messageToSend = cleanedMessage;
    const lastMsgTime = state.lastMessageAt ? new Date(state.lastMessageAt).getTime() : 0;
    if (lastMsgTime && aiMessages.length > 0) {
      const minutesGap = (Date.now() - lastMsgTime) / 60000;
      if (minutesGap > STALE_SESSION_MIN) {
        messageToSend = `[Sistema: pasaron ${Math.round(minutesGap)} min desde el ultimo mensaje. El usuario puede estar retomando o cambiando de tema.]\n\n${cleanedMessage}`;
      }
    }

    // Add user message
    aiMessages.push({ role: 'user', content: messageToSend });

    // Smart trim: keep recent messages + preserve tool results from older ones
    const trimmed = this.smartTrimHistory(aiMessages);

    let response: any;
    let loopCount = 0;
    const currentMessages = [...trimmed];

    try {
      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;

        console.log(`[AI] Sending to Claude (loop ${loopCount}), messages: ${currentMessages.length}`);
        response = await this.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: MODEL_MAX_TOKENS,
          temperature: MODEL_TEMPERATURE,
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
      let finalText = textBlocks.map((b: any) => b.text).join('\n') || 'No se pudo procesar el mensaje.';

      // Post-process: validate quality, strip UUIDs, enforce length
      finalText = this.validateResponse(finalText);

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
            lastMessageAt: new Date().toISOString(),
          },
          expiresAt: new Date(Date.now() + AI_SESSION_TIMEOUT_MIN * 60 * 1000),
        },
      });

      // Check if any tool set pending buttons in session state
      const updatedSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const updatedState = (updatedSession?.flowState as any) || {};
      const pendingButtons = updatedState._pendingButtons || undefined;

      // Clear pending buttons from session
      if (pendingButtons) {
        const { _pendingButtons, ...cleanState } = updatedState;
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: { flowState: { ...cleanState, aiMessages: updatedState.aiMessages, lastMessageAt: updatedState.lastMessageAt } },
        });
      }

      return { text: finalText, buttons: pendingButtons };
    } catch (e) {
      console.error(`[AI] Chat error:`, e.message, e.stack?.slice(0, 300));
      this.logger.error(`AI chat error: ${e.message}`);
      return { text: 'Se produjo un inconveniente tecnico. Por favor, intente nuevamente o utilice las opciones del menu.' };
    }
  }

  // ======================== SYSTEM PROMPT ================================

  private buildSystemPrompt(user: any, companyType: string): string {
    const name = user.name?.split(' ')[0] || 'usuario';
    const today = new Date().toISOString().split('T')[0];

    return `Usted se comunica con Tolvink, plataforma de gestion de fletes de granos.

USUARIO: ${name} | Perfil: ${companyType} | Fecha: ${today}

═══ PROTOCOLO DE COMUNICACION (OBLIGATORIO) ═══

ESTILO:
- Tono formal, profesional e institucional.
- Tratamiento de USTED en toda comunicacion (usted, su, le, puede, debe).
- PROHIBIDO: tuteo, voseo, expresiones coloquiales (genial, dale, barbaro, jaja, etc.).
- PROHIBIDO: interjecciones informales, risas, muletillas conversacionales.
- PROHIBIDO: disclaimers ("cabe mencionar", "es importante notar").
- NO salude si ya lo hizo en esta conversacion.
- NO repita informacion ya proporcionada.
- SALUDOS SIN SOLICITUD: Si el usuario envia un saludo generico ("hola", "buenas", "buen dia", etc.)
  sin una solicitud concreta, responda UNICAMENTE con el menu de presentacion del sistema.
  NO genere respuestas conversacionales ante saludos iniciales.

EMOJIS:
- Solo emojis funcionales relacionados con operaciones logisticas.
- Permitidos: 🚛 📍 🏢 👤 📦 📅 ⚠️ 📋 📄
- PROHIBIDOS: emojis recreativos, emocionales o decorativos.
- Maximo 2 emojis por mensaje.

FORMATO:
- Respuestas breves: 2-4 lineas para consultas simples.
- Listas: maximo 5 items, una linea por item con "▸" como viñeta.
- PROHIBIDO usar asteriscos para negritas. NUNCA escriba *texto*. Texto plano siempre.
- Use "·" como separador entre datos en una misma linea.
- Use "─────────────────────" como linea divisoria cuando necesite separar bloques.
- NUNCA use markdown de enlaces [text](url). Incluya URLs directas.
- Estructura en bloques claros. Titulos breves en mayusculas cuando corresponda.
- Separar informacion critica en lineas independientes.
- Evitar parrafos extensos. Priorizar bullets concretos.

PRIORIDAD EN CADA RESPUESTA:
1. Claridad operativa.
2. Confirmacion de datos clave.
3. Siguientes pasos concretos.
4. Eliminar contenido ornamental o innecesario.

═══ REGLAS ANTI-ALUCINACION (CRITICAS) ═══

1. SOLO afirme datos provenientes de resultados de herramientas. NUNCA invente.
2. Si una herramienta devuelve error o vacio, informelo. No improvise datos.
3. NUNCA invente codigos FLT-XXXX, nombres de plantas, toneladas, fechas, patentes.
4. NUNCA confirme que una accion se ejecuto si la herramienta no lo hizo.
5. Si no dispone de la informacion, responda: "No se dispone de esa informacion."
6. Ante incertidumbre, consulte antes de actuar.
7. NUNCA exponga UUIDs internos. Solo codigos FLT-XXXX.
8. Audio transcripto puede contener errores. Interprete la INTENCION del usuario.

═══ MANEJO DE DATOS FALTANTES ═══

- Falta 1 dato → consulte ESE dato puntualmente.
- Faltan 2+ datos → solicite todos en una lista con bullets.
- Consulta ambigua → formule UNA pregunta de clarificacion.
- Cambio de tema → continue con el nuevo tema sin mezclar.
- Mensaje confuso → solicite aclaracion en una linea.

═══ PRIORIDAD DE CONTEXTO ═══

1. Ultimo mensaje del usuario (maxima prioridad).
2. Datos de operacion en curso (flete pendiente, ubicacion guardada).
3. Resultados de herramientas ejecutadas (datos facticos).
4. Historial de conversacion (solo como referencia).

═══ DOMINIO: FLETES DE GRANOS ═══

ESTADOS: pending_assignment → assigned → accepted → in_progress → loaded → finished (o canceled)
GRANOS: Soja, Maiz, Trigo, Girasol, Sorgo, Cebada, Otros

PERMISOS:
- Productores: crear fletes, consultar estado, gestionar campos/lotes/camiones.
- Plantas: asignar transportistas, asignar camiones, confirmar recepcion (loaded → finished).
- Transportistas/Choferes: aceptar, rechazar, iniciar viaje, confirmar carga/entrega.
- Rechazo/cancelacion SIEMPRE requiere motivo.
- NO se permite cancelar en estado in_progress o loaded.
- Confirmacion de carga requiere toneladas reales.

═══ CREAR FLETES (INSTRUCCIONES CRITICAS) ═══

1. Resolver IDs primero: usar search_plants y list_lots (o list_fields).
2. Llamar prepare_freight con los datos. Esto NO crea el flete, solo lo prepara.
3. Presentar resumen y consultar: "Confirma la creacion del flete?"
4. Cuando confirme → OBLIGATORIO llamar confirm_create_freight.
   SIN esta llamada el flete NO existe. NUNCA indique que fue creado sin ejecutarla.
5. Si faltan datos, solicite SOLO los faltantes. NO asuma valores.

FLOTA PROPIA:
- list_trucks para consultar camiones. Incluir truckId en prepare_freight.

UBICACIONES:
- Ubicacion de WhatsApp compartida → se guarda automaticamente en sesion.
- Para ubicacion precisa → generate_location_link.
- Una vez confirmada en el mapa, se utiliza automaticamente.

CAMPOS Y LOTES:
- list_fields para existentes. create_field / create_lot para nuevos.

USUARIOS:
- Solo admin/gerente puede crear con create_user.

SEGUIMIENTO EN VIVO:
- generate_tracking_link para generar link de seguimiento (ruta y posicion en tiempo real).
- Solo disponible para fletes activos (no finalizados ni cancelados).
- El link no expira y puede compartirse.

INFORME PDF:
- generate_report_link para generar link de descarga del informe PDF.
- Disponible para cualquier flete, incluso finalizados o cancelados.
- El link no expira y puede compartirse.

═══ ASIGNAR TRANSPORTISTA (SOLO PLANTAS) ═══

1. El usuario de planta solicita asignar transportista a un flete.
2. Utilizar list_transporters para presentar opciones disponibles.
3. Al seleccionar, presentar resumen: flete + transportista seleccionado.
4. Consultar: "Confirma la asignacion?"
5. Solo tras confirmacion → ejecutar assign_transporter.
6. Opcional: list_trucks y list_drivers para asignar camion/chofer especifico.
7. assign_truck_to_trip para modificar camion de un viaje existente.
8. Para fletes multi-camion, indicar que utilicen la aplicacion web.

═══ GESTIONAR EQUIPO ═══

CONSULTAR (cualquier usuario):
- list_company_users → miembros de la empresa con rol y estado.
- list_drivers → choferes con camion asignado.

MODIFICAR (solo admin/gerente):
- update_user_role → cambiar rol (gerente/operario/chofer).
  SIEMPRE confirmar: "Confirma el cambio de rol de [nombre] a [rol]?"
- deactivate_user → desactivar usuario de la empresa.
  SIEMPRE confirmar: "Confirma la desactivacion de [nombre]?"
- NUNCA ejecute acciones de modificacion sin confirmacion explicita.
- NUNCA modifique accesos si el usuario no es admin/gerente.

═══ ERRORES ═══

- Traduzca errores tecnicos a lenguaje claro y profesional.
- Plataforma web: ${APP_URL}`;
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
          truckCount: { type: 'number', description: 'Se auto-calcula a partir de tons/30 si no se pasa' },
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
          role: { type: 'string', enum: ['admin', 'gerente', 'operario', 'chofer'], description: 'Rol: admin/gerente, operario, o chofer (default: operario)' },
        },
        required: ['name', 'email', 'password'],
      },
    },
    // ---- Location picker ----
    {
      name: 'generate_location_link',
      description: 'Genera un link para que el usuario elija una ubicacion en un mapa de Google Maps. Usalo cuando el usuario necesite marcar una ubicacion personalizada (origen, destino, campo, lote). El usuario abre el link, pinea la ubicacion, y las coordenadas se guardan automaticamente en la sesion.',
      input_schema: {
        type: 'object' as const,
        properties: {
          purpose: { type: 'string', enum: ['origin', 'destination', 'field', 'lot'], description: 'Para que es la ubicacion' },
        },
        required: ['purpose'],
      },
    },
    // ---- Tracking link ----
    {
      name: 'generate_tracking_link',
      description: 'Genera un link publico para rastrear un flete en vivo en Google Maps. Muestra ruta completa (origen → destino) y posicion del camion en tiempo real. Solo funciona para fletes activos (no finalizados ni cancelados). El link no expira mientras el flete este activo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete (FLT-XXXX)' },
        },
        required: ['code'],
      },
    },
    // ---- Report PDF link ----
    {
      name: 'generate_report_link',
      description: 'Genera un link publico para descargar el informe PDF de un flete. Incluye informacion completa, recorrido, historial de cambios y documentos. Funciona para cualquier flete (incluso finalizados o cancelados). El link no expira.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete (FLT-XXXX)' },
        },
        required: ['code'],
      },
    },
    // ---- Transporter assignment (plant only) ----
    {
      name: 'list_transporters',
      description: 'Lista las empresas transportistas disponibles. Solo para plantas.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'assign_transporter',
      description: 'Asigna un transportista a un flete pendiente de asignacion. SOLO para plantas. IMPORTANTE: siempre mostra resumen y pregunta "Confirmas?" antes de ejecutar.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
          transporterCompanyId: { type: 'string', description: 'ID de empresa transportista (de list_transporters)' },
          truckId: { type: 'string', description: 'ID del camion (opcional, de list_trucks)' },
          driverId: { type: 'string', description: 'ID del chofer (opcional, de list_drivers)' },
        },
        required: ['code', 'transporterCompanyId'],
      },
    },
    {
      name: 'assign_truck_to_trip',
      description: 'Asigna o cambia el camion de un viaje existente (asignacion activa/aceptada). Solo para plantas.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo FLT-XXXX' },
          truckId: { type: 'string', description: 'ID del camion (de list_trucks)' },
          driverId: { type: 'string', description: 'ID del chofer (opcional)' },
        },
        required: ['code', 'truckId'],
      },
    },
    // ---- Company team management ----
    {
      name: 'list_company_users',
      description: 'Lista todos los usuarios de la empresa del usuario actual con roles y estado.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'list_drivers',
      description: 'Lista los choferes de la empresa con camion asignado.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'update_user_role',
      description: 'Cambia el rol de un usuario de la empresa. Solo admin/gerente. CRITICO: pregunta "Seguro que queres cambiar el rol de [nombre] a [rol]?" ANTES de ejecutar.',
      input_schema: {
        type: 'object' as const,
        properties: {
          userIdentifier: { type: 'string', description: 'Nombre o email del usuario' },
          newRole: { type: 'string', enum: ['gerente', 'operario', 'chofer'], description: 'Nuevo rol' },
        },
        required: ['userIdentifier', 'newRole'],
      },
    },
    {
      name: 'deactivate_user',
      description: 'Desactiva un usuario de la empresa. Solo admin/gerente. CRITICO: pregunta "Seguro que queres desactivar a [nombre]?" ANTES de ejecutar.',
      input_schema: {
        type: 'object' as const,
        properties: {
          userIdentifier: { type: 'string', description: 'Nombre o email del usuario a desactivar' },
        },
        required: ['userIdentifier'],
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
        case 'generate_location_link': return await this.toolGenerateLocationLink(input, session);
        case 'generate_tracking_link': return await this.toolGenerateTrackingLink(input);
        case 'generate_report_link': return await this.toolGenerateReportLink(input);
        case 'list_transporters': return await this.toolListTransporters(user);
        case 'assign_transporter': return await this.toolAssignTransporter(input, user, synUser);
        case 'assign_truck_to_trip': return await this.toolAssignTruckToTrip(input, user, synUser);
        case 'list_company_users': return await this.toolListCompanyUsers(user);
        case 'list_drivers': return await this.toolListDrivers(user);
        case 'update_user_role': return await this.toolUpdateUserRole(input, user);
        case 'deactivate_user': return await this.toolDeactivateUser(input, user);
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
    // Input validation
    if (!input.grain || typeof input.grain !== 'string') {
      return JSON.stringify({ error: 'Falta el tipo de grano (grain).' });
    }
    if (!input.tons || isNaN(Number(input.tons)) || Number(input.tons) <= 0) {
      return JSON.stringify({ error: 'Falta la cantidad de toneladas (tons) o es invalida.' });
    }
    if (!input.loadDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.loadDate)) {
      return JSON.stringify({ error: 'Falta la fecha de carga (loadDate) o formato invalido. Usa YYYY-MM-DD.' });
    }
    if (!input.loadTime || !/^\d{2}:\d{2}$/.test(input.loadTime)) {
      return JSON.stringify({ error: 'Falta la hora de carga (loadTime) o formato invalido. Usa HH:MM.' });
    }
    if (input.truckCount !== undefined && (isNaN(Number(input.truckCount)) || Number(input.truckCount) < 1)) {
      return JSON.stringify({ error: 'truckCount debe ser un numero >= 1.' });
    }

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

    // Auto-calculate truck count: ~30 tn per truck (standard grain transport)
    const tons = Number(input.tons);
    const autoTruckCount = Math.max(1, Math.ceil(tons / 30));
    const truckCount = input.truckCount || autoTruckCount;

    const dateFormatted = input.loadDate.split('-').reverse().join('/');
    const summary: any = {
      grain: input.grain,
      tons: input.tons,
      truckCount,
      origin: originDisplayName,
      dest: destDisplayName,
      date: dateFormatted,
      time: input.loadTime,
      notes: input.notes || null,
    };
    if (truckDisplay) summary.truck = truckDisplay;

    // Store pending freight + pending confirm buttons in session
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          pendingFreight: { ...input, truckCount },
          _pendingButtons: [
            { id: 'ai_confirm_freight', title: 'CONFIRMAR' },
            { id: 'ai_cancel_freight', title: 'CANCELAR' },
          ],
        },
      },
    });

    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      IMPORTANT: 'El flete NO fue creado todavia. Mostra el resumen y pregunta al usuario si confirma. Se enviaran botones CONFIRMAR/CANCELAR automaticamente.',
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
        // Use != null checks (Decimal 0 is falsy in JS but may be a valid-ish value)
        // Also skip 0,0 which means "no real coordinates"
        const lotLat = lot.lat != null && Number(lot.lat) !== 0 ? Number(lot.lat) : null;
        const lotLng = lot.lng != null && Number(lot.lng) !== 0 ? Number(lot.lng) : null;
        const fieldLat = lot.field?.lat != null && Number(lot.field.lat) !== 0 ? Number(lot.field.lat) : null;
        const fieldLng = lot.field?.lng != null && Number(lot.field.lng) !== 0 ? Number(lot.field.lng) : null;
        const lat = lotLat ?? fieldLat;
        const lng = lotLng ?? fieldLng;
        console.log(`[AI] Lot coords: lot(${lot.lat},${lot.lng}) field(${lot.field?.lat},${lot.field?.lng}) → resolved(${lat},${lng})`);
        if (lat != null && lng != null) {
          dto.overrideOriginLat = lat;
          dto.overrideOriginLng = lng;
        }
      }
    }
    // If no lot or lot had no coords, use custom origin
    if (!pending.originLotId || !dto.overrideOriginLat) {
      if (!pending.originLotId) {
        dto.customOriginName = pending.customOriginName || 'Origen WhatsApp';
      }
      if (pending.customOriginLat && pending.customOriginLng) {
        dto.overrideOriginLat = pending.customOriginLat;
        dto.overrideOriginLng = pending.customOriginLng;
      } else if (!dto.overrideOriginLat) {
        // Default fallback coords (Montevideo) so freight creation doesn't fail
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
    if (!this.isCallerAdmin(user)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden crear usuarios.' });
    }

    const producerCompanyId = this.resolveProducerCompanyId(user);
    const companyType = this.resolveCompanyType(user);
    const primaryType = companyType.split(',')[0]?.trim() || 'producer';

    // Map Spanish role names to Prisma UserRole enum (admin | operator | platform_admin)
    const inputRole = input.role || 'operario';
    const roleToEnum: Record<string, string> = {
      admin: 'admin', gerente: 'admin',
      operario: 'operator', chofer: 'operator',
    };
    const prismaRole = roleToEnum[inputRole] || 'operator';

    const dto: any = {
      name: input.name,
      email: input.email,
      password: input.password,
      phone: input.phone || null,
      role: prismaRole,
      companyId: producerCompanyId,
      userTypes: [primaryType],
      companyByType: { [primaryType]: producerCompanyId },
      roleByType: { [primaryType]: inputRole },
    };

    const newUser = await this.adminService.createUser(dto);
    return JSON.stringify({
      status: 'created',
      user: { id: (newUser as any).id, name: (newUser as any).name, email: (newUser as any).email, role: inputRole },
      message: `Usuario "${input.name}" creado con rol ${inputRole}.`,
    });
  }

  // ======================== LOCATION PICKER TOOL ==========================

  // ---- generate_location_link ----
  private async toolGenerateLocationLink(input: any, session: any): Promise<string> {
    const token = require('crypto').randomUUID();
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const state = (freshSession?.flowState as any) || {};

    const newFlowState = {
      ...state,
      locationToken: {
        token,
        purpose: input.purpose || 'general',
        createdAt: new Date().toISOString(),
      },
    };

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: { flowState: newFlowState },
    });

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.vercel.app';
    const url = `${frontendUrl}/pick-location?token=${token}`;

    const purposeLabels: Record<string, string> = {
      origin: 'origen del flete',
      destination: 'destino del flete',
      field: 'ubicacion del campo',
      lot: 'ubicacion del lote',
    };
    const label = purposeLabels[input.purpose] || 'ubicacion';

    // Store pending buttons in session for the router to send after AI text
    const freshSess = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const sessState = (freshSess?.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...sessState,
          _pendingButtons: [
            { id: 'location_done', title: 'UBICACION LISTA' },
          ],
        },
      },
    });

    return JSON.stringify({
      url,
      message: `Abra el siguiente link para seleccionar el ${label} en el mapa. Una vez confirmada la ubicacion, presione el boton.`,
    });
  }

  // ---- generate_tracking_link ----
  private async toolGenerateTrackingLink(input: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Codigo de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: { id: true, status: true, shareToken: true, code: true },
    });

    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    if (['finished', 'canceled'].includes(freight.status)) {
      return JSON.stringify({ error: `El flete ${code} ya esta ${freight.status === 'finished' ? 'finalizado' : 'cancelado'}` });
    }

    // Reuse existing token or generate new one
    let token = freight.shareToken;
    if (!token) {
      token = require('crypto').randomUUID();
      await this.prisma.freight.update({
        where: { id: freight.id },
        data: { shareToken: token },
      });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.vercel.app';
    const url = `${frontendUrl}/track?token=${token}`;

    return JSON.stringify({
      url,
      message: `Aca tenes el link de seguimiento en vivo del flete ${code}. Abrilo para ver la ruta y posicion del camion en tiempo real.`,
    });
  }

  // ---- generate_report_link ----
  private async toolGenerateReportLink(input: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Codigo de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: { id: true, status: true, shareToken: true, code: true },
    });

    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Reuse existing token or generate new one
    let token = freight.shareToken;
    if (!token) {
      token = require('crypto').randomUUID();
      await this.prisma.freight.update({
        where: { id: freight.id },
        data: { shareToken: token },
      });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.vercel.app';
    const url = `${frontendUrl}/report?token=${token}`;

    return JSON.stringify({
      url,
      message: `Aca tenes el link para descargar el informe PDF del flete ${code}. Abrilo desde cualquier dispositivo.`,
    });
  }

  // ======================== TRANSPORTER ASSIGNMENT TOOLS ==================

  // ---- list_transporters ----
  private async toolListTransporters(user: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!companyType.includes('plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden listar transportistas.' });
    }

    const companies = await this.prisma.company.findMany({
      where: { active: true },
      select: { id: true, name: true, phone: true, type: true, types: true },
      orderBy: { name: 'asc' },
    });

    const transporters = companies.filter(c =>
      c.type === 'transporter' ||
      (Array.isArray(c.types) && (c.types as string[]).includes('transporter')),
    ).slice(0, 15);

    if (transporters.length === 0) {
      return JSON.stringify({ total: 0, transporters: [], message: 'No hay transportistas disponibles.' });
    }

    return JSON.stringify({
      total: transporters.length,
      transporters: transporters.map(c => ({ id: c.id, name: c.name, phone: c.phone })),
    });
  }

  // ---- assign_transporter ----
  private async toolAssignTransporter(input: any, user: any, synUser: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!companyType.includes('plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden asignar transportistas.' });
    }

    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });

    const plantCompanyId = this.resolvePlantCompanyId(user);
    const plantSynUser = {
      ...synUser,
      companyId: plantCompanyId,
      companyType: 'plant',
      userType: 'plant',
    };

    const dto: any = { transportCompanyId: input.transporterCompanyId };
    if (input.truckId) dto.truckId = input.truckId;
    if (input.driverId) dto.driverId = input.driverId;

    await this.freights.assign(freight.id, dto, plantSynUser);

    const transporter = await this.prisma.company.findUnique({
      where: { id: input.transporterCompanyId },
      select: { name: true },
    });

    return JSON.stringify({
      status: 'done',
      code: freight.code,
      transporter: transporter?.name || 'Transportista',
      message: `Transportista "${transporter?.name}" asignado a ${freight.code}.`,
    });
  }

  // ---- assign_truck_to_trip ----
  private async toolAssignTruckToTrip(input: any, user: any, synUser: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!companyType.includes('plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden editar asignaciones.' });
    }

    const freight = await this.resolveFreight(input.code);
    if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });

    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { freightId: freight.id, status: { in: ['active', 'accepted'] } },
      select: { id: true },
    });
    if (!assignment) {
      return JSON.stringify({ error: `${input.code} no tiene asignacion activa.` });
    }

    const plantCompanyId = this.resolvePlantCompanyId(user);
    const plantSynUser = {
      ...synUser,
      companyId: plantCompanyId,
      companyType: 'plant',
      userType: 'plant',
    };

    const dto: any = { truckId: input.truckId };
    if (input.driverId) dto.driverId = input.driverId;

    await this.freights.updateAssignment(freight.id, assignment.id, dto, plantSynUser);

    const truck = await this.prisma.truck.findUnique({
      where: { id: input.truckId },
      select: { plate: true, model: true },
    });

    return JSON.stringify({
      status: 'done',
      code: freight.code,
      truck: truck ? (truck.model ? `${truck.plate} (${truck.model})` : truck.plate) : 'Asignado',
      message: `Camion ${truck?.plate || ''} asignado a ${freight.code}.`,
    });
  }

  // ======================== TEAM MANAGEMENT TOOLS =========================

  // ---- list_company_users ----
  private async toolListCompanyUsers(user: any): Promise<string> {
    const companyIds: string[] = [];
    if (user.activeCompanyId) companyIds.push(user.activeCompanyId);
    else if (user.companyId) companyIds.push(user.companyId);

    if (user.memberships?.length > 0) {
      for (const m of user.memberships) {
        if (m.companyId && !companyIds.includes(m.companyId)) {
          companyIds.push(m.companyId);
        }
      }
    }

    if (companyIds.length === 0) {
      return JSON.stringify({ error: 'No se encontro tu empresa.', users: [] });
    }

    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId: { in: companyIds }, active: true },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, active: true } },
        company: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    const users = memberships
      .filter(m => m.user.active)
      .map(m => ({
        name: m.user.name,
        email: m.user.email,
        phone: m.user.phone,
        role: m.role,
        company: m.company.name,
      }));

    return JSON.stringify({ total: users.length, users });
  }

  // ---- list_drivers ----
  private async toolListDrivers(user: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const drivers = await this.trucksService.listDrivers(synUser);

    if ((drivers as any[]).length === 0) {
      return JSON.stringify({ total: 0, drivers: [], message: 'No hay choferes registrados.' });
    }

    const driverIds = (drivers as any[]).map(d => d.id);
    const trucks = await this.prisma.truck.findMany({
      where: { assignedUserId: { in: driverIds }, active: true },
      select: { assignedUserId: true, plate: true, model: true },
    });
    const truckByDriver = new Map(trucks.map(t => [t.assignedUserId, t]));

    const result = (drivers as any[]).map((d: any) => {
      const truck = truckByDriver.get(d.id);
      return {
        id: d.id,
        name: d.name,
        phone: d.phone,
        assignedTruck: truck ? (truck.model ? `${truck.plate} (${truck.model})` : truck.plate) : null,
      };
    });

    return JSON.stringify({ total: result.length, drivers: result });
  }

  // ======================== ACCESS MANAGEMENT TOOLS ========================

  // ---- update_user_role ----
  private async toolUpdateUserRole(input: any, user: any): Promise<string> {
    if (!this.isCallerAdmin(user)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden cambiar roles.' });
    }

    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar tu empresa.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: true,
        user: {
          active: true,
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontro un usuario "${searchTerm}" en tu empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No podes cambiar tu propio rol.' });
    }

    await this.prisma.userCompany.update({
      where: { id: membership.id },
      data: { role: input.newRole },
    });

    const roleMapping: Record<string, string> = { gerente: 'admin', operario: 'operator', chofer: 'operator' };
    await this.prisma.user.update({
      where: { id: membership.user.id },
      data: { role: (roleMapping[input.newRole] || 'operator') as any },
    });

    return JSON.stringify({
      status: 'done',
      user: membership.user.name,
      newRole: input.newRole,
      message: `Rol de "${membership.user.name}" cambiado a ${input.newRole}.`,
    });
  }

  // ---- deactivate_user ----
  private async toolDeactivateUser(input: any, user: any): Promise<string> {
    if (!this.isCallerAdmin(user)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden desactivar usuarios.' });
    }

    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar tu empresa.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: true,
        user: {
          active: true,
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontro un usuario activo "${searchTerm}" en tu empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No podes desactivarte a vos mismo.' });
    }

    await this.prisma.userCompany.update({
      where: { id: membership.id },
      data: { active: false },
    });

    const otherActive = await this.prisma.userCompany.count({
      where: { userId: membership.user.id, active: true },
    });
    if (otherActive === 0) {
      await this.prisma.user.update({
        where: { id: membership.user.id },
        data: { active: false },
      });
    }

    return JSON.stringify({
      status: 'done',
      user: membership.user.name,
      message: `Usuario "${membership.user.name}" desactivado de tu empresa.`,
    });
  }

  // ======================== MESSAGE PREPROCESSING ========================

  /** Clean audio transcription: strip filler words, normalize whitespace */
  private preprocessMessage(text: string): string {
    let clean = text
      .replace(AUDIO_FILLERS, ' ')       // Strip filler words from voice
      .replace(/\s{2,}/g, ' ')           // Collapse multiple spaces
      .replace(/^[\s,.:;]+/, '')         // Trim leading punctuation artifacts
      .trim();
    return clean || text.trim();         // If cleaning removed everything, keep original
  }

  // ======================== RESPONSE VALIDATION ===========================

  /** Post-process AI response: strip UUIDs, enforce length, quality check */
  private validateResponse(text: string): string {
    // 1. Strip UUID patterns that may have leaked through
    //    BUT preserve UUIDs inside URLs (e.g. pick-location?token=UUID)
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    let clean = text.replace(UUID_RE, (match, offset) => {
      const before = text.slice(Math.max(0, offset - 80), offset);
      if (/https?:\/\/\S*$/i.test(before)) return match; // UUID is part of a URL
      return '[ID interno]';
    });

    // 2. Enforce max length for WhatsApp-friendly responses
    //    Exception: freight lists (contain FLT-) are allowed to be longer
    if (clean.length > MAX_RESPONSE_CHARS && !clean.includes('FLT-')) {
      // Find a natural break point (newline or sentence end)
      const lineBreak = clean.lastIndexOf('\n', MAX_RESPONSE_CHARS);
      if (lineBreak > MAX_RESPONSE_CHARS * 0.5) {
        clean = clean.slice(0, lineBreak);
      } else {
        const sentenceBreak = clean.lastIndexOf('. ', MAX_RESPONSE_CHARS);
        if (sentenceBreak > MAX_RESPONSE_CHARS * 0.5) {
          clean = clean.slice(0, sentenceBreak + 1);
        } else {
          clean = clean.slice(0, MAX_RESPONSE_CHARS);
        }
      }
    }

    // 3. Strip excessive trailing whitespace/newlines
    return clean.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ======================== SMART HISTORY MANAGEMENT =====================

  /** Trim message history intelligently: keep recent + preserve tool results */
  private smartTrimHistory(messages: any[]): any[] {
    if (messages.length <= MAX_HISTORY) return messages;

    // Simple trim: keep last MAX_HISTORY messages
    let trimmed = messages.slice(-MAX_HISTORY);

    // Ensure we don't start with an orphaned tool_result
    // (each tool_result needs a preceding tool_use from the assistant)
    while (trimmed.length > 0) {
      const first = trimmed[0];
      const hasToolResult = first.role === 'user' && Array.isArray(first.content) &&
        first.content.some((b: any) => b.type === 'tool_result');
      if (hasToolResult) {
        trimmed = trimmed.slice(1); // drop the orphan
      } else {
        break;
      }
    }

    // Also ensure we don't end with a tool_use without its tool_result
    while (trimmed.length > 0) {
      const last = trimmed[trimmed.length - 1];
      const hasToolUse = last.role === 'assistant' && Array.isArray(last.content) &&
        last.content.some((b: any) => b.type === 'tool_use');
      if (hasToolUse) {
        trimmed = trimmed.slice(0, -1); // drop trailing tool_use without result
      } else {
        break;
      }
    }

    return trimmed;
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

  private resolvePlantCompanyId(user: any): string | null {
    if (user.memberships?.length > 0) {
      const pm = user.memberships.find((m: any) =>
        m.company?.type === 'plant' ||
        (Array.isArray(m.company?.types) && m.company.types.includes('plant')),
      );
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('plant') && companyByType.plant) {
      return companyByType.plant;
    }
    if (user.company?.type === 'plant') return user.companyId;
    return user.activeCompanyId || user.companyId || null;
  }

  private isCallerAdmin(user: any): boolean {
    const userRole = user.role || '';
    const memberRoles = user.memberships?.map((m: any) => m.role) || [];
    const allRoles = [userRole, ...memberRoles];
    return allRoles.some((r: string) => ['admin', 'gerente', 'platform_admin'].includes(r)) || user.isSuperAdmin;
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

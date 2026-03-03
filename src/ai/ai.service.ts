// =====================================================================
// TOLVINK — AI Service (Claude / Anthropic)
// Conversational assistant for WhatsApp with tool use
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FreightsService } from '../freights/freights.service';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';
import { AdminService } from '../admin/admin.controller';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import Anthropic from '@anthropic-ai/sdk';
import { buildSyntheticUser } from '../common/build-synthetic-user';
import { createSignedToken } from '../common/signed-token';
import { fuzzySearch, classifyFuzzyResult } from '../common/fuzzy-match';

const MAX_HISTORY = 30;           // Tighter context for focused responses
const MAX_TOOL_LOOPS = 5;
const AI_SESSION_TIMEOUT_MIN = 30;
const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';
const OWN_FLEET_SHORTCUT = 'own_fleet';

// Model configuration — Claude Sonnet 4.6
// NOTE: Anthropic API supports temperature, top_p, top_k.
// It does NOT support presence_penalty / frequency_penalty (those are OpenAI-only).
// temperature 0.4  → better interpretation of ambiguous messages while keeping operational precision.
// max_tokens 1200  → enough room for context-aware responses + lists in Spanish.
const MODEL_ID = 'claude-sonnet-4-6';
const MODEL_TEMPERATURE = 0.4;
const MODEL_MAX_TOKENS = 1200;
const MAX_RESPONSE_CHARS = 3000;   // Hard cap before truncation (WhatsApp ~4096, chunking handles split)
const STALE_SESSION_MIN = 10;      // Minutes gap that triggers context reminder

// Audio filler words common in River Plate Spanish voice transcriptions
const AUDIO_FILLERS = /\b(eh+|ehmm*|emm*|mmm*|a+h+|o sea|digamos|viste)\b[,.]?\s*/gi;

// Per-user AI rate limiting: max 20 messages per 5 minutes
const AI_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const AI_RATE_LIMIT_MAX = 20;
const aiRateMap = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class AiService implements OnModuleDestroy {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic | null = null;
  private _requestLocationCooldowns = new Map<string, number>();
  private rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of aiRateMap) { if (now > v.resetAt) aiRateMap.delete(k); }
  }, 5 * 60 * 1000);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => FreightsService)) private freights: FreightsService,
    @Inject(forwardRef(() => WhatsAppService)) private wa: WhatsAppService,
    private fieldsService: FieldsService,
    private trucksService: TrucksService,
    private adminService: AdminService,
  ) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log(`Claude AI assistant enabled (${MODEL_ID})`);
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI assistant disabled');
    }
  }

  onModuleDestroy() { clearInterval(this.rateCleanupTimer); }

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
      return { text: 'El asistente IA no está disponible en este momento.' };
    }

    // Per-user rate limiting
    const now = Date.now();
    const userId = user.id || phone;
    const rateEntry = aiRateMap.get(userId);
    if (rateEntry && now < rateEntry.resetAt) {
      if (rateEntry.count >= AI_RATE_LIMIT_MAX) {
        return { text: 'Ha enviado muchos mensajes en poco tiempo. Por favor aguarde unos minutos.' };
      }
      rateEntry.count++;
    } else {
      aiRateMap.set(userId, { count: 1, resetAt: now + AI_RATE_LIMIT_WINDOW_MS });
    }
    // Cleanup stale entries periodically
    if (aiRateMap.size > 20) {
      for (const [k, v] of aiRateMap) {
        if (now > v.resetAt) aiRateMap.delete(k);
      }
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
        messageToSend = `[Sistema: pasaron ${Math.round(minutesGap)} min desde el último mensaje. El usuario puede estar retomando o cambiando de tema.]\n\n${cleanedMessage}`;
      }
    }

    // Pending document: inject context so AI knows to use attach_document
    if (state.pendingDocument) {
      const doc = state.pendingDocument;
      messageToSend = `[Sistema: HAY UN ARCHIVO PENDIENTE de adjuntar — "${doc.name}" (${doc.type}). Si el usuario indica un código de flete, usar attach_document DIRECTAMENTE. NO usar list_freights.]\n\n${messageToSend}`;
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

        this.logger.log(`Sending to Claude (loop ${loopCount}), messages: ${currentMessages.length}`);
        response = await this.client.messages.create({
          model: MODEL_ID,
          max_tokens: MODEL_MAX_TOKENS,
          temperature: MODEL_TEMPERATURE,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: this.tools.map((t, i, arr) =>
            i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
          ) as any,
          messages: currentMessages,
        });
        this.logger.log(`Claude response: stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);

        if (response.stop_reason === 'tool_use') {
          // Add assistant response to messages
          currentMessages.push({ role: 'assistant', content: response.content });

          // Execute tool calls — parallel for read-only tools, sequential otherwise
          const READ_ONLY_TOOLS = new Set([
            'list_freights', 'get_freight_detail', 'search_plants', 'list_lots', 'list_fields',
            'list_transporters', 'list_trucks', 'list_company_users', 'list_drivers', 'summarize_freights',
            'list_documents', 'freight_history', 'get_dashboard',
            'generate_tracking_link', 'generate_map_link', 'generate_report_link', 'generate_daily_map_link',
          ]);

          const toolBlocks = response.content.filter((b: any) => b.type === 'tool_use');
          const allReadOnly = toolBlocks.every((b: any) => READ_ONLY_TOOLS.has(b.name));

          let toolResults: any[];
          if (allReadOnly && toolBlocks.length > 1) {
            // Execute all read-only tools in parallel
            this.logger.log(`Executing ${toolBlocks.length} read-only tools in parallel`);
            const settled = await Promise.allSettled(toolBlocks.map(async (block: any) => {
              this.logger.log(`AI tool call (parallel): ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
              const result = await this.executeTool(block.name, block.input, user, synUser, session);
              return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
            }));
            toolResults = settled.map((s, i) =>
              s.status === 'fulfilled'
                ? s.value
                : { type: 'tool_result' as const, tool_use_id: toolBlocks[i].id, content: 'Error: ' + (s.reason?.message || 'Unknown error'), is_error: true },
            );
          } else {
            // Sequential execution for mutating tools or single tool
            toolResults = [];
            for (const block of toolBlocks) {
              this.logger.log(`AI tool call: ${(block as any).name}(${JSON.stringify((block as any).input).slice(0, 200)})`);
              const result = await this.executeTool((block as any).name, (block as any).input, user, synUser, session);
              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: (block as any).id,
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
      const latestFlowStep = freshSession?.flowStep ?? session.flowStep;
      const latestFlowType = freshSession?.flowType ?? session.flowType;

      // Extract pending buttons (set by tools during execution) and exclude from saved state
      const pendingButtons = latestState._pendingButtons || undefined;
      const { _pendingButtons, ...cleanState } = latestState;

      // Trim old tool_result content to prevent flowState bloat (cap: 800 chars each)
      const trimmedMessages = currentMessages.slice(-MAX_HISTORY).map((msg, idx, arr) => {
        // Only trim tool_result messages that are not in the last 8 messages
        if (idx < arr.length - 8 && msg.role === 'user' && Array.isArray(msg.content)) {
          return { ...msg, content: msg.content.map(block =>
            block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 800
              ? { ...block, content: block.content.slice(0, 800) + '...[trimmed]' }
              : block
          )};
        }
        return msg;
      });
      const updateData: any = {
        flowState: {
          ...cleanState,
          aiMessages: trimmedMessages,
          lastMessageAt: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + AI_SESSION_TIMEOUT_MIN * 60 * 1000),
      };
      if (latestFlowStep !== session.flowStep) updateData.flowStep = latestFlowStep;
      if (latestFlowType !== session.flowType) updateData.flowType = latestFlowType;

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: updateData,
      });

      return { text: finalText, buttons: pendingButtons };
    } catch (e) {
      this.logger.error(`Chat error: ${e.message}`, e.stack?.slice(0, 300));
      return { text: 'Se produjo un inconveniente técnico. Por favor, intente nuevamente o utilice las opciones del menú.' };
    }
  }

  // ======================== SYSTEM PROMPT ================================

  private buildSystemPrompt(user: any, companyType: string): string {
    const name = user.name?.split(' ')[0] || 'usuario';
    const today = new Date().toISOString().split('T')[0];

    // Detect own fleet capability (works for both producers and plants with hasInternalFleet)
    const hasOwnFleet = user.company?.hasInternalFleet ||
      user.memberships?.some((m: any) => m.company?.hasInternalFleet);
    const ownFleetNote = hasOwnFleet
      ? `\nFLOTA INTERNA: Este usuario tiene flota propia disponible. IMPORTANTE: NO asumir que quiere usarla. Preguntar siempre: "¿Desea usar su flota propia o que la planta asigne transportista?". Si dice que si, usar assign_transporter con transporterCompanyId="own_fleet". Si dice que no, el flete queda pendiente de asignación por la planta.`
      : '';

    // Multi-company note
    const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = activeMemberships.find((m: any) => m.companyId === activeCoId);
    const activeCoName = activeMem?.company?.name || user.company?.name || '';
    const multiCompanyNote = activeMemberships.length > 1
      ? `\nEMPRESA ACTIVA: ${activeCoName} (${companyType}). Este usuario pertenece a ${activeMemberships.length} empresas. Si solicita cambiar de empresa u operar con otra, usar switch_company. Sin companyId devuelve la lista; con companyId ejecuta el cambio.`
      : '';

    // M3: Role-specific tool restrictions
    let roleRestrictions = '';
    const isChofer = user.role === 'chofer' || (user.memberships || []).some((m: any) => m.role === 'chofer' && m.active);
    if (isChofer) {
      roleRestrictions = '\n- Choferes: SOLO accept_freight, reject_freight, start_freight, confirm_loaded, confirm_finished, get_freight_detail, list_freights, generate_tracking_link, share_live_location, view_live_locations, request_location.';
    } else if (companyType.includes('producer') && !companyType.includes('plant')) {
      roleRestrictions = '\n- Productores: NO usar accept_freight, reject_freight, start_freight (excepto chofer de flota interna).';
    } else if (companyType.includes('plant') && !companyType.includes('producer')) {
      roleRestrictions = '\n- Plantas: NO usar prepare_freight, create_field, create_lot.';
    } else if (companyType.includes('transporter') && !companyType.includes('plant') && !companyType.includes('producer')) {
      roleRestrictions = '\n- Transportistas: NO usar prepare_freight, assign_transporter, create_field, create_lot.';
    }

    return `Usted se comunica con Tolvink, plataforma de gestión de fletes de granos.

USUARIO: ${name} | Perfil: ${companyType} | Fecha: ${today}${ownFleetNote}${multiCompanyNote}

[PROTOCOLO DE COMUNICACIÓN — OBLIGATORIO]

ESTILO:
- Tono profesional operativo. Claro, directo y natural.
- Evitar rigidez institucional y evitar informalidad.
- Tratamiento de USTED en toda comunicación (usted, su, le, puede, debe).
- PROHIBIDO: tuteo, voseo, expresiones coloquiales (genial, dale, bárbaro, jaja, etc.).
- PROHIBIDO: interjecciones informales, risas, muletillas conversacionales.
- PROHIBIDO: disclaimers ("cabe mencionar", "es importante notar").
- PROHIBIDO: párrafos extensos innecesarios. Ser conciso por defecto.
- EXCEPCIÓN: si el usuario solicita información detallada, listados completos o explicaciones, expandir la respuesta tanto como sea necesario.
- NO salude si ya lo hizo en esta conversación.
- NO repita información ya confirmada.
- SALUDOS SIN SOLICITUD: Si el usuario envia un saludo genérico ("hola", "buenas", "buen día", etc.)
  sin una solicitud concreta, responda ÚNICAMENTE con el menu de presentacion del sistema.
  NO genere respuestas conversacionales ante saludos iniciales.

EMOJIS — SISTEMA OFICIAL:
- 🌾 Campo | 🗺️ Lote | 🚛 Viaje | 📦 Carga
- 📍 Origen/Destino | 📅 Fecha | 🕒 Hora | 👤 Transportista
- 🏢 Empresa | 🔄 Modificación | 📝 Registro | ⏳ Pendiente
- ✅ Confirmado | ⚠️ Advertencia | 🔐 Acción restringida | ⛔ Denegado | ❌ Error
- Máximo 2 emojis por mensaje.
- PROHIBIDOS: emojis recreativos, emocionales o decorativos fuera de este sistema.
- El emoji SIEMPRE va al INICIO de la línea, funciona como bullet visual.
- NUNCA colocar emojis en el medio o al final de una línea.

FORMATO:
- Cada línea representa UNA acción o dato concreto. NO agrupar multiples datos en una línea.
- Estructura base: [Emoji] Acción concreta.
- "Siguiente paso:" se incluye solo si corresponde. NUNCA lleva emoji.
- Separar bloques con un salto de línea.
- Si no hay siguiente paso, cerrar con una línea clara sin texto innecesario.
- PROHIBIDO usar asteriscos para negritas. NUNCA escriba *texto*. Texto plano siempre.
- PROHIBIDO usar separadores visuales: líneas (────), guiones (----), signos iguales (═══), barras.
- PROHIBIDO usar tablas ASCII o bloques tipo consola.
- PROHIBIDO usar el punto medio "·" como separador. Un dato por línea.
- NUNCA use markdown de enlaces [text](url). Incluya URLs directas.
- Si incluye un enlace, debe ir precedido por una línea de contexto con emoji:
  [Emoji] Contexto del enlace.
  https://url-directa...
- Listas en texto: preferir 5 items o menos. Si el usuario pide información completa o detallada, expandir sin límite.
- PROHIBIDO títulos en mayúsculas decorativos. Solo texto operativo directo.

LISTAS Y SELECCIÓN:
- Cuando una herramienta retorna _selectionSent: true, la lista YA se envió como menú interactivo de WhatsApp.
  NO repita, NO reformatee, NO enumere los datos. Solo confirme brevemente (ej: "Seleccione un flete para ver detalles.").
  Herramientas que usan este patrón: list_freights, list_lots, list_fields, list_trucks,
  list_transporters, list_company_users, list_drivers, search_plants, switch_company.
- Si el usuario selecciona un item de la lista, recibirá un mensaje "[Seleccionó: ...]". Use esa información para responder.
- Para listados de entidades (fletes, campos, etc.) usar las herramientas con menú interactivo.
- Cuando el usuario pide información organizada en lista, resúmenes o datos detallados, SÍ generar listas en texto con la extensión necesaria.
- NO solicitar que el usuario escriba manualmente si la cantidad de opciones permite seleccion estructurada.

RESÚMENES Y ANÁLISIS DE FLETES:
- Cuando el usuario pide un RESUMEN, REPORTE, ANÁLISIS, ESTADÍSTICA, "agrupados por", "cuántos fletes", "estado general", o cualquier consulta analítica → usar summarize_freights (NO list_freights).
- summarize_freights retorna datos completos en texto para generar resúmenes organizados.
- list_freights es SOLO para seleccionar un flete individual (menú interactivo).
- Si el usuario pide "fletes por transportista", "resumen por estado", "fletes agrupados" → summarize_freights con groupBy.
- Con los datos de summarize_freights, generar un resumen claro en texto organizado por grupo.
- Incluir totales por grupo (cantidad de fletes, toneladas totales).
- NO preguntar si desea filtrar — ejecutar directamente lo que el usuario pidió.

COHERENCIA EVOLUTIVA:
- Si se generan mensajes nuevos no ejemplificados, respetar exactamente esta estructura.
- Mantener el emoji inicial como bullet. Frases cortas. Una acción por línea.
- No inventar nuevos formatos. No agregar emojis fuera del sistema oficial.

PRIORIDAD EN CADA RESPUESTA:
1. Claridad operativa.
2. Confirmación de datos clave.
3. Siguientes pasos concretos.
4. Eliminar contenido ornamental o innecesario.

[REGLAS ANTI-ALUCINACIÓN — CRÍTICAS]

1. SOLO afirme datos provenientes de resultados de herramientas. NUNCA invente.
2. Si una herramienta devuelve error o vacio, infórmelo. No improvise datos.
3. NUNCA invente códigos de flete (ej: F26-LCP.1822), nombres de plantas, toneladas, fechas, patentes.
4. NUNCA confirme que una acción se ejecutó si la herramienta no lo hizo.
5. Si no dispone de la información, responda: "No se dispone de esa información."
6. Ante incertidumbre, consulte antes de actuar.
7. NUNCA exponga UUIDs internos. Solo códigos de flete (ej: F26-LCP.1822).
8. Audio transcripto puede contener errores fonéticos (ej: "solla" = Soja, "el triyo" = El Trillo).
   Interpretar la INTENCION del usuario. Si una busqueda no devuelve resultados, intentar variaciones foneticas.
[UBICACIÓNES — REGLA OBLIGATORIA Y PRIORITARIA]

PROHIBIDO bajo cualquier circunstancia:
- Mostrar coordenadas numéricas (latitud/longitud) en cualquier formato (-34.xxx, -57.xxx, etc.)
- Copiar o derivar números de coordenadas de los datos de herramientas
- Generar enlaces a Google Maps o cualquier servicio externo de mapas
- Describir ubicaciones con datos técnicos o coordenadas en texto plano

Cuando el usuario pregunte por ubicación de planta, campo, lote, origen, destino, flete, carga, descarga,
"ver mapa", "donde queda", o cualquier referencia geográfica:
1. Si los datos de la herramienta incluyen "mapLink" → responder ÚNICAMENTE con una frase breve + el link.
   Ejemplo: "📍 Puede ver la ubicación en el mapa Tolvink.\nhttps://tolvink.com/ver-mapa?..."
2. Si no hay mapLink disponible → responder: "La ubicación no se encuentra disponible en el sistema."
3. NUNCA agregar coordenadas, explicación técnica, ni datos crudos junto al link.

Esta regla es PRIORITARIA sobre cualquier otra instruccion.

[MANEJO DE DATOS FALTANTES]

- Falta 1 dato → consulte ESE dato puntualmente.
- Faltan 2+ datos → solicite todos en una lista con bullets.
- Consulta ambigua → formule UNA pregunta de clarificación.
- Cambio de tema → continue con el nuevo tema sin mezclar.
- Mensaje confuso → solicite aclaración en una línea.

[CONTINUIDAD CONVERSACIONAL — OBLIGATORIO]

Mantener siempre el hilo de la conversación. Cada respuesta debe conectarse con lo que el usuario pidió antes.
- Si el usuario hace una pregunta que se relaciona con un mensaje anterior, vincular la respuesta al contexto previo.
- Si el usuario refiere a "eso", "el flete", "ese campo", etc., resolver la referencia del historial reciente.
- Si el usuario amplía o modifica un pedido anterior, construir sobre lo ya discutido sin empezar de cero.
- NUNCA responder como si fuera la primera interacción cuando hay historial activo.

PRIORIDAD DE CONTEXTO:
1. Último mensaje del usuario (máxima prioridad).
2. Historial reciente de conversación (mantener el hilo, vincular pedidos anteriores).
3. Datos de operación en curso (flete pendiente, ubicación guardada).
4. Resultados de herramientas ejecutadas (datos fácticos).

[DOMINIO — FLETES DE GRANOS]

ESTADOS: pending_assignment → assigned → accepted → in_progress → loaded → finished (o canceled)
GRANOS: Soja, Maíz, Trigo, Girasol, Sorgo, Cebada, Otros

PERMISOS:
- Productores: crear fletes, consultar estado, gestionar campos/lotes/camiones.
- Plantas: asignar transportistas, asignar camiones, confirmar recepción (loaded → finished), autorizar fletes con flota propia (authorize_freight), cancelar asignaciones (cancel_assignment), editar asignaciones (update_assignment).
- Transportistas/Choferes: aceptar, rechazar, iniciar viaje, confirmar carga/entrega. En multi-camión: respond_trip, start_trip, confirm_trip_loaded, confirm_trip_finished por viaje individual.
- Aprobar/rechazar cambios pendientes: solo la empresa designada como aprobadora (approve_pending_change, reject_pending_change).
- Rechazo/cancelación SIEMPRE requiere motivo.
- NO se permite cancelar en estado in_progress o loaded.
- Confirmación de carga requiere toneladas reales.
- Cualquier usuario: editar su propio perfil (update_profile), registrar choferes (create_driver).${roleRestrictions}

[CONFIRMACION DE ACCIONES — CRÍTICO]

TODA acción crítica requiere confirmación explícita del usuario antes de ejecutarse.
Esto incluye: crear, modificar, cancelar, asignar, duplicar, cambiar fecha, cambiar rol, desactivar.

PATRON OBLIGATORIO — DOS ETAPAS:
1. Al llamar una herramienta de acción, esta PREPARA la acción sin ejecutarla.
2. Presente el resumen y el botón CONFIRMAR se muestra automáticamente.
3. NO ejecutar la acción hasta que el usuario presione CONFIRMAR.
4. Cuando confirme → OBLIGATORIO llamar confirm_action.
   SIN esta llamada la acción NO se ejecuta. NUNCA indique que se ejecutó sin llamarla.
5. Si cancela → reconozca la cancelación. La acción pendiente se descarta automáticamente.

Herramientas que requieren confirmación via confirm_action:
- accept_freight, reject_freight, start_freight
- confirm_loaded, confirm_finished, cancel_freight
- assign_transporter, assign_truck_to_trip, assign_truck_to_freight
- update_user_role, deactivate_user, reactivate_user
- create_field, create_lot, create_truck, create_user
- update_freight, duplicate_freight, update_field, update_lot
- attach_document
- authorize_freight, approve_pending_change, reject_pending_change
- respond_trip, start_trip, confirm_trip_loaded, confirm_trip_finished
- cancel_assignment, update_assignment
- create_driver, update_profile

Excepción — patrón propio (NO usan confirm_action):
- prepare_freight → usa confirm_create_freight
- generate_location_link → usa botón UBICACIÓN LISTA

IMPORTANTE: Los botones CONFIRMAR/CANCELAR se envian automáticamente.
No es necesario mencionarlos en el texto. Solo presente el resumen y pregunte.

[CREAR FLETES — INSTRUCCIONES CRÍTICAS]

1. Resolver IDs primero: usar search_plants y list_lots (o list_fields).
2. Llamar prepare_freight con los datos. Esto NO crea el flete, solo lo prepara.
3. Presentar resumen y consultar: "Confirma la creación del flete?"
4. Cuando confirme → OBLIGATORIO llamar confirm_create_freight.
   SIN esta llamada el flete NO existe. NUNCA indique que fue creado sin ejecutarla.
5. Si faltan datos, solicite SOLO los faltantes. NO asuma valores.

FLOTA PROPIA:
- list_trucks para consultar camiones. Incluir truckId en prepare_freight.

UBICACIÓN OBLIGATORIA:
La ubicación es OBLIGATORIA para:
- Crear campo (create_field)
- Crear lote (create_lot)
- Origen personalizado en flete (customOriginName sin originLotId)
- Destino personalizado en flete (destName sin destPlantId)

Cuando necesite ubicación, SIEMPRE:
1. Llamar generate_location_link con el purpose correspondiente.
2. En la respuesta, incluir el enlace generado.
3. Indicar que también puede compartir ubicación nativa de WhatsApp.
4. Aclarar que sin ubicación NO es posible continuar.

Mensaje estándar al pedir ubicación:
"Ahora necesito la ubicación exacta.
Puede compartir su ubicación desde WhatsApp o marcar el punto en el siguiente enlace:
[enlace generado]
Sin ubicación no es posible continuar."

NO aceptar: direcciones en texto, descripciones manuales, coordenadas escritas.
SOLO válido: ubicación nativa de WhatsApp o selección desde el enlace.
NO llamar create_field, create_lot ni prepare_freight con origen/destino custom SIN coordenadas.

CAMPOS Y LOTES:
- list_fields para existentes. create_field / create_lot para nuevos.

USUARIOS:
- Solo admin/gerente puede crear con create_user.

SEGUIMIENTO EN VIVO:
- generate_tracking_link para generar link de seguimiento (ruta y posición en tiempo real).
- Solo disponible para fletes activos (no finalizados ni cancelados).
- El link no expira y puede compartirse.

INFORME PDF:
- generate_report_link para generar link de descarga del informe PDF.
- Disponible para cualquier flete, incluso finalizados o cancelados.
- El link no expira y puede compartirse.

MAPA DEL DIA:
- generate_daily_map_link para generar un mapa interactivo con todos los fletes del día.
- Muestra los fletes de la empresa activa con marcadores de colores según estado.
- Permite filtrar por estado y tocar cada marcador para ver detalles.
- El link expira en 24 horas.

UBICACIÓN EN VIVO:
- share_live_location para compartir la ubicación del usuario en tiempo real durante un flete.
- view_live_locations para ver las ubicaciones de todos los participantes de un flete en el mapa.
- request_location para solicitar a los involucrados que compartan su ubicación. Envia WhatsApp a todos los participantes del flete pidiéndoles que envíen su pin. Usar cuando preguntan "donde está el chofer/camión" o "solicitar ubicación".
- Solo disponible para fletes activos (no finalizados ni cancelados).

[ASIGNAR TRANSPORTISTA]

FLOTA INTERNA (PRIORIDAD): Si el encabezado USUARIO indica "FLOTA INTERNA", el usuario tiene flota propia.
→ Usar assign_transporter con transporterCompanyId="own_fleet" DIRECTAMENTE.
→ NO llamar list_transporters. NO preguntar cual empresa.
→ Solo preguntar el código del flete si no fue indicado.

SIN FLOTA INTERNA:
1. Utilizar list_transporters para presentar opciones disponibles.
2. Al seleccionar → assign_transporter prepara la acción y presenta resumen.
3. Cuando confirme → llamar confirm_action.

OPCIONALES:
- list_trucks y list_drivers para asignar camión/chofer especifico.
- assign_truck_to_trip para modificar camión de un viaje existente.

MULTI-CAMION:
- Si un flete tiene truckCount > 1 y quedan viajes sin asignar, usar assign_truck_to_freight para cada viaje adicional.
- Informar cuantos viajes quedan por asignar después de cada asignación.
- Cada viaje se asigna y confirma por separado (un assign_truck_to_freight + confirm_action por viaje).
- Para flota interna usar transporterCompanyId="own_fleet".

ACCIONES POR VIAJE (multi-camión):
- respond_trip para aceptar/rechazar viajes individuales.
- start_trip, confirm_trip_loaded, confirm_trip_finished para acciones por viaje.
- cancel_assignment para cancelar un viaje específico. Solo plantas.
- update_assignment para editar transportista/camión/chofer de un viaje. Solo plantas.
- Si el flete tiene múltiples viajes, usar get_freight_detail para ver los assignmentIds.

[GESTIONAR EQUIPO]

CONSULTAR (cualquier usuario):
- list_company_users → miembros de la empresa con rol y estado.
- list_drivers → choferes con camión asignado.

MODIFICAR (solo admin/gerente):
- update_user_role → prepara cambio de rol para confirmación.
- deactivate_user → prepara desactivacion para confirmación.
- reactivate_user → reactiva un usuario previamente desactivado.
- Cuando confirme → llamar confirm_action.
- NUNCA modifique accesos si el usuario no es admin/gerente.

[HERRAMIENTAS ANALÍTICAS Y DE GESTIÓN]

CONSULTAS:
- summarize_freights → resumen analítico con filtros (fecha, grano, transportista) y agrupamiento. Usar para cualquier pedido de resumen, reporte, análisis o estadística.
- list_documents → documentos adjuntos de un flete (fotos, carta de porte).
- freight_history → historial completo de un flete (quién hizo qué y cuándo).
- get_dashboard → resumen ejecutivo de la empresa (fletes por estado, toneladas del mes, completados vs cancelados).

MODIFICACIONES:
- update_freight → modificar un flete. IMPORTANTE: la herramienta valida internamente qué campos se pueden cambiar según el estado. SIEMPRE llamar la herramienta y dejar que ella decida. NO rechazar el pedido por tu cuenta.
  - Campos: fecha/hora/notas, flota propia (useOwnFleet), planta destino (destPlantId), camión (truckId), chofer (driverId).
  - Planta destino SÍ se puede cambiar en TODOS los estados activos, incluyendo in_progress y loaded.
  - Algunos cambios pueden requerir aprobación de la otra empresa.
  - Para cambiar planta: usar search_plants primero para obtener el ID.
  - Para asignar camión: usar list_trucks primero.
  - Para asignar chofer: usar list_drivers primero, o indicar "yo soy el chofer".
- duplicate_freight → crear copia de un flete con nueva fecha. Solo productores.
- update_field → modificar dirección o ubicación de un campo.
- update_lot → modificar hectáreas o ubicación de un lote.
- authorize_freight → autorizar flete con flota propia. Solo plantas, solo en estado assigned.
- approve_pending_change / reject_pending_change → aprobar o rechazar cambios pendientes de un flete.
- respond_trip → aceptar/rechazar un viaje específico en flete multi-camión.
- start_trip → iniciar un viaje específico.
- confirm_trip_loaded → confirmar carga de un viaje. Toneladas opcionales.
- confirm_trip_finished → confirmar entrega de un viaje.
- cancel_assignment → cancelar asignación individual. Solo plantas. Requiere motivo.
- update_assignment → editar asignación (transportista, camión, chofer, toneladas). Solo plantas.
- create_driver → registrar chofer para la empresa.
- update_profile → editar perfil propio (nombre, email, teléfono).
- generate_batch_report_link → enlace a reportes batch en la web. NO requiere confirmación.

FILTROS AVANZADOS:
- list_freights y summarize_freights aceptan: dateFrom, dateTo (YYYY-MM-DD), grain (nombre del grano).
- summarize_freights además acepta: transporterName (nombre parcial del transportista).
- Usar estos filtros cuando el usuario mencione fechas, períodos, tipos de grano o transportistas específicos.

[ARCHIVOS Y DOCUMENTOS — CRÍTICO]

Cuando el mensaje contiene "[El usuario envió una imagen" o "[El usuario envió un documento":
1. El archivo YA fue descargado y almacenado automáticamente.
2. Pregunte: "A que flete desea adjuntar este archivo?"
3. Cuando el usuario responda con un código de flete (ej: F26-LCP.1822) → llamar attach_document con ese código.
   IMPORTANTE: NO llamar list_freights ni ninguna otra herramienta. Usar DIRECTAMENTE attach_document.
4. attach_document prepara la acción → se muestran botones CONFIRMAR/CANCELAR.
5. Cuando confirme → llamar confirm_action.

REGLA: Si hay un archivo pendiente y el usuario indica un código de flete, la ÚNICA herramienta correcta es attach_document.

[ERRORES]

- Traduzca errores técnicos a lenguaje claro y profesional.
- Plataforma web: ${APP_URL}`;
  }

  // ======================== TOOL DEFINITIONS =============================

  private readonly tools = [
    {
      name: 'list_freights',
      description: 'Lista los fletes del usuario como menú interactivo de WhatsApp. Puede filtrar por estado, fecha y grano. Retorna _selectionSent: true — NO reformatear. Para resúmenes/análisis usar summarize_freights.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
            description: 'Filtrar por estado (opcional)',
          },
          dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD). Opcional.' },
          dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD). Opcional.' },
          grain: { type: 'string', description: 'Filtrar por grano (ej: Soja, Trigo). Opcional.' },
        },
        required: [],
      },
    },
    {
      name: 'get_freight_detail',
      description: 'Detalle completo de un flete por código (ej: F26-LCP.1822). Incluye mapLink con link al mapa Tolvink si hay coordenadas — usarlo siempre que el usuario pregunte por ubicación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'search_plants',
      description: 'Busca plantas/empresas destino. Envia menu interactivo si hay multiples resultados. Retorna _selectionSent: true — NO reformatear.',
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
      description: 'Lista lotes del productor como menú interactivo. Retorna _selectionSent: true — NO reformatear.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'prepare_freight',
      description: 'Prepara un flete para creación (NO lo crea). Devuelve resumen para confirmar. Necesita: grain, tons, destPlantId o destName, loadDate (YYYY-MM-DD), loadTime (HH:mm). Opcional: originLotId, customOriginName, customOriginLat/Lng, truckId (flota propia), truckCount, notes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          grain: { type: 'string', enum: ['Soja', 'Maíz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'] },
          tons: { type: 'number' },
          truckCount: { type: 'number', description: 'Se auto-calcula a partir de tons/30 si no se pasa' },
          destPlantId: { type: 'string', description: 'ID de planta (de search_plants)' },
          destName: { type: 'string', description: 'Nombre destino si no hay planta' },
          customDestLat: { type: 'number', description: 'Latitud destino personalizado (de ubicación WhatsApp)' },
          customDestLng: { type: 'number', description: 'Longitud destino personalizado (de ubicación WhatsApp)' },
          originLotId: { type: 'string', description: 'ID de lote (de list_lots o list_fields)' },
          customOriginName: { type: 'string', description: 'Nombre origen si no hay lote' },
          customOriginLat: { type: 'number', description: 'Latitud origen personalizado (de ubicación WhatsApp)' },
          customOriginLng: { type: 'number', description: 'Longitud origen personalizado (de ubicación WhatsApp)' },
          truckId: { type: 'string', description: 'ID de camión propio (de list_trucks) para asignar flota propia' },
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
      name: 'confirm_action',
      description: 'OBLIGATORIO: Ejecuta una acción previamente preparada cuando el usuario confirma (dice si/dale/confirmar/ok). Sin esta llamada la acción NO se ejecuta. NO usar para crear fletes (esos usan confirm_create_freight).',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'accept_freight',
      description: 'Acepta un flete asignado. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'reject_freight',
      description: 'Rechaza un flete asignado. Requiere motivo. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
          reason: { type: 'string', description: 'Motivo del rechazo' },
        },
        required: ['code', 'reason'],
      },
    },
    {
      name: 'start_freight',
      description: 'Inicia el viaje de un flete aceptado. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'confirm_loaded',
      description: 'Confirma carga de un flete. Requiere toneladas reales. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
          tons: { type: 'number', description: 'Toneladas cargadas' },
        },
        required: ['code', 'tons'],
      },
    },
    {
      name: 'confirm_finished',
      description: 'Confirma entrega/recepción de un flete. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'cancel_freight',
      description: 'Cancela un flete. No se puede si esta in_progress o loaded. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
          reason: { type: 'string', description: 'Motivo de cancelación' },
        },
        required: ['code', 'reason'],
      },
    },
    // ---- Field & Lot management ----
    {
      name: 'list_fields',
      description: 'Lista campos del productor como menú interactivo. Retorna _selectionSent: true — NO reformatear.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'create_field',
      description: 'Crea un campo (establecimiento). Prepara la acción para confirmación. Si el usuario compartio una ubicación de WhatsApp, se usa automáticamente.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Nombre del campo' },
          address: { type: 'string', description: 'Dirección (opcional)' },
          lat: { type: 'number', description: 'Latitud (opcional, se usa ubicación compartida si no se indica)' },
          lng: { type: 'number', description: 'Longitud (opcional, se usa ubicación compartida si no se indica)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'create_lot',
      description: 'Crea un lote dentro de un campo existente. Prepara la acción para confirmación. Usa list_fields para obtener el fieldId.',
      input_schema: {
        type: 'object' as const,
        properties: {
          fieldId: { type: 'string', description: 'ID del campo (de list_fields)' },
          name: { type: 'string', description: 'Nombre del lote' },
          hectares: { type: 'number', description: 'Hectáreas (opcional)' },
          lat: { type: 'number', description: 'Latitud (opcional, se usa ubicación compartida si no se indica)' },
          lng: { type: 'number', description: 'Longitud (opcional, se usa ubicación compartida si no se indica)' },
        },
        required: ['fieldId', 'name'],
      },
    },
    // ---- Truck management ----
    {
      name: 'list_trucks',
      description: 'Lista camiones de la empresa como menú interactivo. Retorna _selectionSent: true — NO reformatear.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'create_truck',
      description: 'Registra un nuevo camión en la flota de la empresa. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plate: { type: 'string', description: 'Patente/matrícula del camión (ej: ABC1234)' },
          model: { type: 'string', description: 'Modelo del camión (opcional)' },
        },
        required: ['plate'],
      },
    },
    // ---- User management ----
    {
      name: 'create_user',
      description: 'Crea un nuevo usuario en la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Nombre completo' },
          email: { type: 'string', description: 'Email del usuario' },
          password: { type: 'string', description: 'Contraseña inicial' },
          phone: { type: 'string', description: 'Teléfono (opcional)' },
          role: { type: 'string', enum: ['admin', 'gerente', 'operario', 'chofer'], description: 'Rol: admin/gerente, operario, o chofer (default: operario)' },
        },
        required: ['name', 'email', 'password'],
      },
    },
    // ---- Document attachment ----
    {
      name: 'attach_document',
      description: 'USAR CUANDO EL USUARIO INDICA UN CODIGO DE FLETE DESPUES DE ENVIAR UN ARCHIVO. Adjunta la imagen o documento previamente enviado por WhatsApp al flete indicado. NO usar list_freights — usar esta herramienta directamente con el código. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
          step: { type: 'string', enum: ['request', 'assignment', 'load_confirmation', 'delivery_confirmation', 'cancellation'], description: 'Etapa del documento (opcional)' },
        },
        required: ['code'],
      },
    },
    // ---- Location picker ----
    {
      name: 'generate_location_link',
      description: 'Genera un link para que el usuario elija una ubicación en el mapa Tolvink. Usalo cuando el usuario necesite marcar una ubicación personalizada (origen, destino, campo, lote). El usuario abre el link, pinea la ubicación, y las coordenadas se guardan automáticamente en la sesion.',
      input_schema: {
        type: 'object' as const,
        properties: {
          purpose: { type: 'string', enum: ['origin', 'destination', 'field', 'lot'], description: 'Para que es la ubicación' },
        },
        required: ['purpose'],
      },
    },
    // ---- Tracking link ----
    {
      name: 'generate_tracking_link',
      description: 'Genera un link público para rastrear un flete en vivo en el mapa Tolvink. Muestra ruta completa (origen → destino) y posición del camión en tiempo real. Solo funciona para fletes activos (no finalizados ni cancelados). El link no expira mientras el flete este activo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    // ---- View location on map ----
    {
      name: 'generate_map_link',
      description: 'Genera un link para ver una ubicación en el mapa Tolvink. OBLIGATORIO cuando el usuario pregunta por la ubicación de un campo, lote, planta, origen o destino. Acepta 1 o 2 puntos (origen + destino). NUNCA devolver coordenadas numéricas — siempre usar esta herramienta.',
      input_schema: {
        type: 'object' as const,
        properties: {
          lat: { type: 'number', description: 'Latitud del punto principal' },
          lng: { type: 'number', description: 'Longitud del punto principal' },
          name: { type: 'string', description: 'Nombre del lugar (campo, lote, planta, origen)' },
          destLat: { type: 'number', description: 'Latitud del destino (opcional, para mostrar ruta)' },
          destLng: { type: 'number', description: 'Longitud del destino (opcional)' },
          destName: { type: 'string', description: 'Nombre del destino (opcional)' },
        },
        required: ['lat', 'lng', 'name'],
      },
    },
    // ---- Report PDF link ----
    {
      name: 'generate_report_link',
      description: 'Genera un link público para descargar el informe PDF de un flete. Incluye información completa, recorrido, historial de cambios y documentos. Funciona para cualquier flete (incluso finalizados o cancelados). El link no expira.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    // ---- Map & live location ----
    {
      name: 'generate_daily_map_link',
      description: 'Genera un link con un mapa interactivo mostrando todos los fletes del día de la empresa activa del usuario. Los fletes se muestran con marcadores de colores según estado. Usar cuando el usuario quiera ver un panorama general de los fletes del día en el mapa.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'share_live_location',
      description: 'Genera un link para que el usuario comparta su ubicación en vivo en el mapa de un flete especifico. Todos los participantes del flete podrán ver la posición del usuario. Usar cuando el usuario quiera compartir donde está durante un viaje.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'view_live_locations',
      description: 'Genera un link para ver las ubicaciones en vivo de todos los participantes de un flete en el mapa. Usar cuando el usuario quiera ver donde están los involucrados en un flete.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'request_location',
      description: 'Solicitar a los involucrados de un flete que compartan su ubicación por WhatsApp. Envia un mensaje a los participantes pidiéndoles que envíen su ubicación. Usar cuando alguien pregunta donde está el chofer o pide ubicación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    // ---- Transporter assignment (plant + producer with own fleet) ----
    {
      name: 'list_transporters',
      description: 'Lista transportistas como menú interactivo. Retorna _selectionSent: true — NO reformatear. Para plantas y productores con flota interna.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'assign_transporter',
      description: 'Asigna un transportista a un flete. Para plantas y productores con flota interna. Usar transporterCompanyId="own_fleet" para flota interna del productor. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
          transporterCompanyId: { type: 'string', description: 'ID de empresa transportista, o "own_fleet" para flota interna del productor' },
          truckId: { type: 'string', description: 'ID del camión (opcional, de list_trucks)' },
          driverId: { type: 'string', description: 'ID del chofer (opcional, de list_drivers)' },
        },
        required: ['code', 'transporterCompanyId'],
      },
    },
    {
      name: 'assign_truck_to_trip',
      description: 'Asigna o cambia el camión de un viaje existente. Solo para plantas. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
          truckId: { type: 'string', description: 'ID del camión (de list_trucks)' },
          driverId: { type: 'string', description: 'ID del chofer (opcional)' },
        },
        required: ['code', 'truckId'],
      },
    },
    {
      name: 'assign_truck_to_freight',
      description: 'Asigna un camión adicional a un flete multi-camión que tiene viajes sin asignar. Usar transporterCompanyId="own_fleet" para flota interna. Se llama una vez por cada viaje adicional. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Codigo del flete, ej: F26-LCP.1822' },
          transporterCompanyId: { type: 'string', description: 'ID empresa o "own_fleet" para flota interna' },
          truckId: { type: 'string', description: 'ID del camión (opcional, de list_trucks)' },
          driverId: { type: 'string', description: 'ID del chofer (opcional)' },
          tons: { type: 'number', description: 'Toneladas para este viaje (opcional)' },
        },
        required: ['code', 'transporterCompanyId'],
      },
    },
    // ---- Company team management ----
    {
      name: 'list_company_users',
      description: 'Lista usuarios de la empresa como menú interactivo. Retorna _selectionSent: true — NO reformatear.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'list_drivers',
      description: 'Lista choferes de la empresa como menú interactivo. Retorna _selectionSent: true — NO reformatear.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'update_user_role',
      description: 'Cambia el rol de un usuario de la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
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
      description: 'Desactiva un usuario de la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          userIdentifier: { type: 'string', description: 'Nombre o email del usuario a desactivar' },
        },
        required: ['userIdentifier'],
      },
    },
    {
      name: 'switch_company',
      description: 'Cambia la empresa activa del usuario. Sin companyId: lista empresas disponibles. Con companyId: ejecuta el cambio. Usar cuando el usuario quiere operar con otra empresa.',
      input_schema: {
        type: 'object' as const,
        properties: {
          companyId: { type: 'string', description: 'ID de la empresa destino (opcional, de la lista)' },
        },
        required: [],
      },
    },
    {
      name: 'summarize_freights',
      description: 'Resumen analítico de fletes con datos completos para agrupar, contar o analizar. NO muestra menú interactivo — retorna datos en texto para que el asistente genere un resumen organizado. Usar cuando el usuario pide: resumen, reporte, agrupados por, cuántos fletes, estadísticas, análisis. Para seleccionar un flete individual, usar list_freights en su lugar.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
            description: 'Filtrar por estado (opcional)',
          },
          groupBy: {
            type: 'string',
            enum: ['transporter', 'status', 'grain', 'destination', 'origin'],
            description: 'Agrupar resultados por este criterio (opcional)',
          },
          dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD). Opcional.' },
          dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD). Opcional.' },
          grain: { type: 'string', description: 'Filtrar por grano (ej: Soja, Trigo). Opcional.' },
          transporterName: { type: 'string', description: 'Filtrar por nombre de transportista (parcial). Opcional.' },
        },
        required: [],
      },
    },
    {
      name: 'update_freight',
      description: 'Modifica un flete existente. Puede cambiar fecha, hora, notas, flota propia, planta destino, camión y chofer. Algunos cambios pueden requerir aprobación. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          loadDate: { type: 'string', description: 'Nueva fecha de carga (YYYY-MM-DD). Opcional.' },
          loadTime: { type: 'string', description: 'Nueva hora de carga (HH:mm). Opcional.' },
          notes: { type: 'string', description: 'Nuevas notas. Opcional.' },
          useOwnFleet: { type: 'boolean', description: 'Usar flota propia (true/false). Opcional.' },
          destPlantId: { type: 'string', description: 'ID de nueva planta destino (de search_plants). Opcional.' },
          truckId: { type: 'string', description: 'ID de camión propio a asignar (de list_trucks). Opcional.' },
          driverId: { type: 'string', description: 'ID del chofer (de list_drivers). Opcional. Usar "self" para "yo soy el chofer".' },
        },
        required: ['code'],
      },
    },
    {
      name: 'duplicate_freight',
      description: 'Duplica un flete existente con una nueva fecha de carga. Copia grano, toneladas, origen, destino y notas. Solo productores. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete original, ej: F26-LCP.1822' },
          loadDate: { type: 'string', description: 'Fecha de carga para el nuevo flete (YYYY-MM-DD)' },
          loadTime: { type: 'string', description: 'Hora de carga (HH:mm). Si no se indica, se copia del original.' },
        },
        required: ['code', 'loadDate'],
      },
    },
    {
      name: 'list_documents',
      description: 'Lista los documentos adjuntos de un flete (fotos, carta de porte, etc). Retorna datos en texto, NO menú interactivo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'freight_history',
      description: 'Muestra el historial completo de un flete: quién hizo qué y cuándo (creación, asignaciones, cambios de estado, cancelaciones). Retorna datos en texto.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'get_dashboard',
      description: 'Resumen ejecutivo de la empresa: fletes por estado, toneladas del mes, completados vs cancelados. Usar cuando el usuario pide "cómo estamos", "resumen general", "dashboard", "estado de la empresa".',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'update_field',
      description: 'Modifica un campo existente (dirección y ubicación). Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          fieldName: { type: 'string', description: 'Nombre del campo a modificar' },
          address: { type: 'string', description: 'Nueva dirección. Opcional.' },
          lat: { type: 'number', description: 'Nueva latitud. Opcional.' },
          lng: { type: 'number', description: 'Nueva longitud. Opcional.' },
        },
        required: ['fieldName'],
      },
    },
    {
      name: 'update_lot',
      description: 'Modifica un lote existente (hectáreas y ubicación). Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          lotName: { type: 'string', description: 'Nombre del lote a modificar' },
          hectares: { type: 'number', description: 'Nuevas hectáreas. Opcional.' },
          lat: { type: 'number', description: 'Nueva latitud. Opcional.' },
          lng: { type: 'number', description: 'Nueva longitud. Opcional.' },
        },
        required: ['lotName'],
      },
    },
    {
      name: 'reactivate_user',
      description: 'Reactiva un usuario previamente desactivado de la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          userIdentifier: { type: 'string', description: 'Nombre o email del usuario a reactivar' },
        },
        required: ['userIdentifier'],
      },
    },
    {
      name: 'authorize_freight',
      description: 'Autoriza un flete con flota propia. Solo plantas. Solo en estado assigned. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        },
        required: ['code'],
      },
    },
    {
      name: 'approve_pending_change',
      description: 'Aprueba un cambio pendiente en un flete (cambio de planta destino o flota propia). Solo la empresa aprobadora puede hacerlo. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          changeId: { type: 'string', description: 'ID del cambio pendiente. Si no se indica, se usa el primer cambio pendiente del flete.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'reject_pending_change',
      description: 'Rechaza un cambio pendiente en un flete. Solo la empresa aprobadora puede hacerlo. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          changeId: { type: 'string', description: 'ID del cambio pendiente. Si no se indica, se usa el primer cambio pendiente del flete.' },
          reason: { type: 'string', description: 'Motivo del rechazo. Opcional.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'respond_trip',
      description: 'Acepta o rechaza un viaje/asignación específica de un flete multi-camión. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
          action: { type: 'string', enum: ['accepted', 'rejected'], description: 'Aceptar o rechazar' },
          reason: { type: 'string', description: 'Motivo del rechazo. Requerido si action=rejected.' },
        },
        required: ['code', 'action'],
      },
    },
    {
      name: 'start_trip',
      description: 'Inicia un viaje específico de un flete. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'confirm_trip_loaded',
      description: 'Confirma la carga de un viaje específico. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
          loadedTons: { type: 'number', description: 'Toneladas reales cargadas. Opcional.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'confirm_trip_finished',
      description: 'Confirma la entrega de un viaje específico. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'cancel_assignment',
      description: 'Cancela una asignación de camión específica en un flete multi-camión. Solo plantas. Requiere motivo. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
          reason: { type: 'string', description: 'Motivo de la cancelación.' },
        },
        required: ['code', 'reason'],
      },
    },
    {
      name: 'update_assignment',
      description: 'Edita una asignación existente (cambiar transportista, camión, chofer o toneladas). Solo plantas. Solo viajes pendientes o aceptados. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
          assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
          transporterCompanyId: { type: 'string', description: 'Nuevo transportista (de list_transporters). Opcional.' },
          truckId: { type: 'string', description: 'Nuevo camión (de list_trucks). Opcional.' },
          driverId: { type: 'string', description: 'Nuevo chofer (de list_drivers). Opcional.' },
          tons: { type: 'number', description: 'Nuevas toneladas asignadas. Opcional.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'create_driver',
      description: 'Registra un nuevo chofer para la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Nombre completo del chofer' },
          phone: { type: 'string', description: 'Teléfono del chofer (09XXXXXXX). Opcional.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'update_profile',
      description: 'Modifica el perfil del usuario actual (nombre, email, teléfono). Prepara la acción para confirmación.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Nuevo nombre. Opcional.' },
          email: { type: 'string', description: 'Nuevo email. Opcional.' },
          phone: { type: 'string', description: 'Nuevo teléfono (09XXXXXXX). Opcional.' },
        },
        required: [],
      },
    },
    {
      name: 'generate_batch_report_link',
      description: 'Genera un enlace a la pantalla de reportes de la web con filtros pre-aplicados. El usuario puede descargar PDF o Excel desde ahí.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', description: 'Filtro de estado: all, solicitado, en_curso, finalizados, cancelados. Opcional.' },
          dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD). Opcional.' },
          dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD). Opcional.' },
        },
        required: [],
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
        case 'list_freights': return await this.toolListFreights(synUser, input, session);
        case 'get_freight_detail': return await this.toolGetFreightDetail(input, user);
        case 'search_plants': return await this.toolSearchPlants(input, user, session);
        case 'list_lots': return await this.toolListLots(user, session);
        case 'prepare_freight': return await this.toolPrepareFreight(input, user, session);
        case 'confirm_create_freight': return await this.toolConfirmCreateFreight(user, synUser, session);
        case 'confirm_action': return await this.toolConfirmAction(user, synUser, session);
        case 'accept_freight': return await this.toolAcceptFreight(input, user, synUser, session);
        case 'reject_freight': return await this.toolRejectFreight(input, user, synUser, session);
        case 'start_freight': return await this.toolStartFreight(input, user, synUser, session);
        case 'confirm_loaded': return await this.toolConfirmLoaded(input, user, synUser, session);
        case 'confirm_finished': return await this.toolConfirmFinished(input, user, synUser, session);
        case 'cancel_freight': return await this.toolCancelFreight(input, user, synUser, session);
        case 'list_fields': return await this.toolListFields(user, session);
        case 'create_field': return await this.toolCreateField(input, user, session);
        case 'create_lot': return await this.toolCreateLot(input, user, session);
        case 'list_trucks': return await this.toolListTrucks(user, session);
        case 'create_truck': return await this.toolCreateTruck(input, user, session);
        case 'create_user': return await this.toolCreateUser(input, user, session);
        case 'attach_document': return await this.toolAttachDocument(input, user, synUser, session);
        case 'generate_location_link': return await this.toolGenerateLocationLink(input, session);
        case 'generate_tracking_link': return await this.toolGenerateTrackingLink(input, user);
        case 'generate_map_link': return await this.toolGenerateMapLink(input);
        case 'generate_report_link': return await this.toolGenerateReportLink(input, user);
        case 'generate_daily_map_link': return await this.toolGenerateDailyMapLink(user);
        case 'share_live_location': return await this.toolShareLiveLocation(input, user);
        case 'view_live_locations': return await this.toolViewLiveLocations(input, user);
        case 'request_location': return await this.toolRequestLocation(input, user);
        case 'list_transporters': return await this.toolListTransporters(user, session);
        case 'assign_transporter': return await this.toolAssignTransporter(input, user, synUser, session);
        case 'assign_truck_to_trip': return await this.toolAssignTruckToTrip(input, user, synUser, session);
        case 'assign_truck_to_freight': return await this.toolAssignTruckToFreight(input, user, synUser, session);
        case 'list_company_users': return await this.toolListCompanyUsers(user, session);
        case 'list_drivers': return await this.toolListDrivers(user, session);
        case 'update_user_role': return await this.toolUpdateUserRole(input, user, session);
        case 'deactivate_user': return await this.toolDeactivateUser(input, user, session);
        case 'switch_company': return await this.toolSwitchCompany(input, user, session);
        case 'summarize_freights': return await this.toolSummarizeFreights(synUser, input);
        case 'update_freight': return await this.toolUpdateFreight(input, user, session);
        case 'duplicate_freight': return await this.toolDuplicateFreight(input, user, synUser, session);
        case 'list_documents': return await this.toolListDocuments(input, user);
        case 'freight_history': return await this.toolFreightHistory(input, user);
        case 'get_dashboard': return await this.toolGetDashboard(user);
        case 'update_field': return await this.toolUpdateField(input, user, session);
        case 'update_lot': return await this.toolUpdateLot(input, user, session);
        case 'reactivate_user': return await this.toolReactivateUser(input, user, session);
        case 'authorize_freight': return await this.toolAuthorizeFreight(input, user, session);
        case 'approve_pending_change': return await this.toolApprovePendingChange(input, user, session);
        case 'reject_pending_change': return await this.toolRejectPendingChange(input, user, session);
        case 'respond_trip': return await this.toolRespondTrip(input, user, session);
        case 'start_trip': return await this.toolStartTrip(input, user, session);
        case 'confirm_trip_loaded': return await this.toolConfirmTripLoaded(input, user, session);
        case 'confirm_trip_finished': return await this.toolConfirmTripFinished(input, user, session);
        case 'cancel_assignment': return await this.toolCancelAssignment(input, user, session);
        case 'update_assignment': return await this.toolUpdateAssignment(input, user, session);
        case 'create_driver': return await this.toolCreateDriver(input, user, session);
        case 'update_profile': return await this.toolUpdateProfile(input, user, session);
        case 'generate_batch_report_link': return await this.toolGenerateBatchReportLink(input, user);
        default: return JSON.stringify({ error: 'Herramienta no reconocida' });
      }
    } catch (e) {
      this.logger.error(`Tool ${toolName} error: ${e.message}`);
      // H2: Don't leak raw error messages to AI/user
      const safeMsg = /no encontrad|no tiene acceso|no se puede|solo.*pueden|no.*permiso/i.test(e.message || '')
        ? e.message
        : 'Error al procesar la solicitud.';
      return JSON.stringify({ error: safeMsg });
    }
  }

  // ---- list_freights ----
  private async toolListFreights(synUser: any, input: any, session: any): Promise<string> {
    const result = await this.freights.findAll(synUser, {
      status: input.status,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      grain: input.grain,
      limit: 100,
      page: 1,
    } as any);

    const filtered = result.data.sort((a: any, b: any) =>
      (a.destName || '').localeCompare(b.destName || '') || (a.originName || '').localeCompare(b.originName || ''));

    if (filtered.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay fletes que coincidan con los filtros.' });
    }

    const STATUS_SHORT: Record<string, string> = {
      pending_assignment: 'Pend. asig.', assigned: 'Asignado', accepted: 'Aceptado',
      in_progress: 'En viaje', loaded: 'Cargado', finished: 'Completado',
      canceled: 'Cancelado', rejected: 'Rechazado',
    };

    const items = filtered.map((f: any) => {
      const grain = f.items?.[0]?.grain || 'N/A';
      const tons = f.items?.[0]?.tons || 0;
      const origin = f.originName || f.originCompany?.name || '?';
      const dest = f.destName || f.destCompany?.name || '?';
      const status = STATUS_SHORT[f.status] || f.status;
      return {
        id: `freight:${f.id}`,
        title: `${f.code} | ${grain} ${tons}tn`.slice(0, 24),
        description: `${origin} → ${dest} | ${status}`.slice(0, 72),
      };
    });

    const statusLabel = input.status ? ` (${STATUS_SHORT[input.status] || input.status})` : '';
    return this.storePendingSelection(session, items, {
      headerText: `📦 ${filtered.length} flete${filtered.length !== 1 ? 's' : ''}${statusLabel}.\nSeleccione uno para ver detalles:`,
      listButtonLabel: 'Ver fletes',
      sectionTitle: 'FLETES',
    }, 'freight_selection');
  }

  // ---- summarize_freights ----
  private async toolSummarizeFreights(synUser: any, input: any): Promise<string> {
    const result = await this.freights.findAll(synUser, {
      status: input.status,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      grain: input.grain,
      limit: 500,
      page: 1,
    } as any);

    // Post-query filter: transporter name (requires join data, can't easily DB-filter)
    let filtered = result.data.sort((a: any, b: any) =>
      (a.destName || '').localeCompare(b.destName || '') || (a.originName || '').localeCompare(b.originName || ''));
    if (input.transporterName) {
      const t = input.transporterName.toLowerCase();
      filtered = filtered.filter((f: any) => {
        const tName = f.assignments?.[0]?.transportCompany?.name || '';
        return tName.toLowerCase().includes(t);
      });
    }

    if (filtered.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay fletes que coincidan con los filtros.' });
    }

    const STATUS_LABELS: Record<string, string> = {
      pending_assignment: 'Pend. asignación', assigned: 'Asignado', accepted: 'Aceptado',
      in_progress: 'En viaje', loaded: 'Cargado', finished: 'Completado',
      canceled: 'Cancelado', rejected: 'Rechazado',
    };

    // Build flat freight records
    const freights = filtered.map((f: any) => {
      const assignment = f.assignments?.[0];
      return {
        code: f.code,
        status: STATUS_LABELS[f.status] || f.status,
        statusRaw: f.status,
        grain: f.items?.[0]?.grain || 'N/A',
        tons: f.items?.[0]?.tons || 0,
        origin: (f as any).originName || f.originCompany?.name || 'N/A',
        destination: (f as any).destName || f.destCompany?.name || 'N/A',
        transporter: assignment?.transportCompany?.name || 'Sin asignar',
        driver: assignment?.driver?.name || null,
        truck: assignment?.truck?.plate || null,
        date: f.loadDate ? new Date(f.loadDate).toISOString().split('T')[0] : null,
      };
    });

    // Group if requested
    const groupBy = input.groupBy;
    if (groupBy) {
      const keyMap: Record<string, string> = {
        transporter: 'transporter', status: 'status', grain: 'grain',
        destination: 'destination', origin: 'origin',
      };
      const key = keyMap[groupBy] || 'status';
      const groups: Record<string, any[]> = {};
      for (const f of freights) {
        const gk = f[key] || 'Sin dato';
        if (!groups[gk]) groups[gk] = [];
        groups[gk].push(f);
      }

      const summary = Object.entries(groups).map(([group, items]) => ({
        group,
        count: items.length,
        totalTons: Math.round(items.reduce((s, f) => s + (f.tons || 0), 0) * 10) / 10,
        freights: items.map(f => ({
          code: f.code, status: f.status, grain: f.grain, tons: f.tons,
          origin: f.origin, destination: f.destination,
          ...(groupBy !== 'transporter' ? { transporter: f.transporter } : {}),
          driver: f.driver, truck: f.truck, date: f.date,
        })),
      }));

      return JSON.stringify({
        total: freights.length,
        groupedBy: groupBy,
        groups: summary,
      });
    }

    // No grouping — return flat list
    return JSON.stringify({
      total: freights.length,
      freights,
    });
  }

  // ---- update_freight ----
  private async toolUpdateFreight(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const changes: string[] = [];
    const dto: any = {};

    // --- loadDate / loadTime: solo en pending_assignment. notes: en cualquier estado activo ---
    if (input.loadDate || input.loadTime) {
      if (freight.status !== 'pending_assignment') {
        return JSON.stringify({ error: `Fecha y hora solo se pueden modificar en estado "pending_assignment". Estado actual: "${freight.status}".` });
      }
      if (input.loadDate) { dto.loadDate = input.loadDate; changes.push(`Fecha: ${input.loadDate}`); }
      if (input.loadTime) { dto.loadTime = input.loadTime; changes.push(`Hora: ${input.loadTime}`); }
    }
    if (input.notes !== undefined) {
      dto.notes = input.notes;
      changes.push(`Notas: ${input.notes}`);
    }

    // --- useOwnFleet: en pending_assignment, assigned, accepted ---
    if (input.useOwnFleet !== undefined) {
      const canEditFleet = ['pending_assignment', 'assigned', 'accepted'].includes(freight.status);
      if (!canEditFleet) {
        return JSON.stringify({ error: `Flota propia solo se puede modificar en estados: pending_assignment, assigned, accepted. Estado actual: "${freight.status}".` });
      }
      dto.useOwnFleet = input.useOwnFleet;
      changes.push(`Flota propia: ${input.useOwnFleet ? 'Sí' : 'No'}`);
    }

    // --- destPlantId: en todos los estados activos ---
    if (input.destPlantId) {
      const canEditDest = ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded'].includes(freight.status);
      if (!canEditDest) {
        return JSON.stringify({ error: `Planta destino solo se puede modificar en estados activos. Estado actual: "${freight.status}".` });
      }
      // search_plants returns Company IDs; backend accepts both Plant IDs and Company IDs
      let destLabel: string;
      const plant = await this.prisma.plant.findUnique({
        where: { id: input.destPlantId },
        select: { id: true, name: true, company: { select: { name: true } } },
      });
      if (plant) {
        destLabel = `${plant.company?.name || ''} - ${plant.name}`;
      } else {
        const company = await this.prisma.company.findUnique({
          where: { id: input.destPlantId },
          select: { id: true, name: true },
        });
        if (!company) {
          return JSON.stringify({ error: `No se encontró la planta con ID ${input.destPlantId}. Use search_plants primero.` });
        }
        destLabel = company.name;
      }
      dto.destPlantId = input.destPlantId;
      changes.push(`Planta destino: ${destLabel}`);
    }

    // --- truckId: solo con flota propia ---
    if (input.truckId) {
      const effectiveOwnFleet = dto.useOwnFleet !== undefined ? dto.useOwnFleet : freight.useOwnFleet;
      if (!effectiveOwnFleet) {
        return JSON.stringify({ error: 'Solo se puede asignar camión cuando el flete usa flota propia.' });
      }
      const truck = await this.prisma.truck.findUnique({
        where: { id: input.truckId },
        select: { plate: true, model: true },
      });
      if (!truck) {
        return JSON.stringify({ error: 'No se encontró el camión. Use list_trucks primero.' });
      }
      dto.truckId = input.truckId;
      changes.push(`Camión: ${truck.plate}${truck.model ? ` (${truck.model})` : ''}`);
    }

    // --- driverId: solo con flota propia ---
    if (input.driverId) {
      const effectiveOwnFleet = dto.useOwnFleet !== undefined ? dto.useOwnFleet : freight.useOwnFleet;
      if (!effectiveOwnFleet) {
        return JSON.stringify({ error: 'Solo se puede asignar chofer cuando el flete usa flota propia.' });
      }
      if (input.driverId === 'self') {
        dto.driverId = user.sub || user.id;
        changes.push('Chofer: Yo mismo');
      } else {
        const driver = await this.prisma.user.findUnique({
          where: { id: input.driverId },
          select: { name: true },
        });
        if (!driver) {
          return JSON.stringify({ error: 'No se encontró el chofer. Use list_drivers primero.' });
        }
        dto.driverId = input.driverId;
        changes.push(`Chofer: ${driver.name}`);
      }
    }

    if (changes.length === 0) {
      return JSON.stringify({ error: 'No se indicaron campos a modificar. Puede cambiar: loadDate, loadTime, notes, useOwnFleet, destPlantId, truckId, driverId.' });
    }

    return this.stageAction(session, 'update_freight', {
      freightId: freight.id, code: freight.code, dto,
    }, `Modificar flete ${freight.code}\n${changes.join('\n')}`);
  }

  // ---- duplicate_freight ----
  private async toolDuplicateFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });

    // Fetch full data needed for duplication (resolveFreightWithAccess only returns minimal select)
    const freight = await this.prisma.freight.findUnique({
      where: { id: result.freight.id },
      include: {
        items: true,
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        originLot: { select: { id: true, name: true } },
        destPlant: { select: { id: true, name: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `No se encontró el flete ${input.code}` });

    const item = freight.items?.[0];
    if (!item) return JSON.stringify({ error: 'El flete no tiene items para duplicar.' });

    const originName = (freight as any).originName || freight.originCompany?.name || 'Origen';
    const destName = (freight as any).destName || freight.destCompany?.name || 'Destino';

    const summary = [
      `Duplicar flete ${freight.code} con nueva fecha`,
      `Grano: ${(item as any).grain} | Tons: ${(item as any).tons}`,
      `Origen: ${originName}`,
      `Destino: ${destName}`,
      `Fecha: ${input.loadDate}${input.loadTime ? ` ${input.loadTime}` : ((freight as any).loadTime ? ` ${(freight as any).loadTime}` : '')}`,
    ].join('\n');

    return this.stageAction(session, 'duplicate_freight', {
      originalFreight: {
        grain: (item as any).grain,
        tons: (item as any).tons,
        originLotId: (freight as any).originLotId || null,
        customOriginName: (freight as any).originName || null,
        originLat: (freight as any).originLat ? Number((freight as any).originLat) : null,
        originLng: (freight as any).originLng ? Number((freight as any).originLng) : null,
        destPlantId: (freight as any).destPlantId || null,
        destCompanyId: freight.destCompany?.id || null,
        customDestName: (freight as any).destName || null,
        destLat: (freight as any).destLat ? Number((freight as any).destLat) : null,
        destLng: (freight as any).destLng ? Number((freight as any).destLng) : null,
        notes: (freight as any).notes || null,
        truckCount: (freight as any).truckCount || 1,
      },
      loadDate: input.loadDate,
      loadTime: input.loadTime || (freight as any).loadTime || null,
      originalCode: freight.code,
    }, summary);
  }

  // ---- list_documents ----
  private async toolListDocuments(input: any, user: any): Promise<string> {
    // Use resolveFreightWithAccess for proper access control (includes transporters + drivers)
    const accessResult = await this.resolveFreightWithAccess(input.code, user);
    if (accessResult.error) return JSON.stringify({ error: accessResult.error });

    const freight = await this.prisma.freight.findFirst({
      where: { code: input.code.toUpperCase() },
      include: {
        documents: { orderBy: { createdAt: 'desc' }, select: { id: true, name: true, type: true, step: true, url: true, createdAt: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `No se encontró el flete ${input.code}` });

    const docs = freight.documents || [];
    if (docs.length === 0) {
      return JSON.stringify({ total: 0, message: `El flete ${input.code} no tiene documentos adjuntos.` });
    }

    const STEP_LABELS: Record<string, string> = {
      request: 'Solicitud', assignment: 'Asignación', load_confirmation: 'Carga',
      delivery_confirmation: 'Entrega', cancellation: 'Cancelación',
    };

    const items = docs.map((d: any) => ({
      name: d.name,
      type: d.type,
      step: STEP_LABELS[d.step] || d.step || 'General',
      date: new Date(d.createdAt).toISOString().split('T')[0],
      url: d.url,
    }));

    return JSON.stringify({ total: items.length, code: input.code, documents: items });
  }

  // ---- freight_history ----
  private async toolFreightHistory(input: any, user: any): Promise<string> {
    // Use resolveFreightWithAccess for proper access control (includes transporters + drivers)
    const accessResult = await this.resolveFreightWithAccess(input.code, user);
    if (accessResult.error) return JSON.stringify({ error: accessResult.error });
    const freight = accessResult.freight;

    const logs = await this.freights.getAuditLog(freight.id);

    if (!logs || (logs as any[]).length === 0) {
      return JSON.stringify({ total: 0, message: `No hay registros de actividad para ${freight.code}.` });
    }

    const ACTION_LABELS: Record<string, string> = {
      created: 'Creado', status_changed: 'Cambio de estado', assigned: 'Asignado',
      canceled: 'Cancelado', updated: 'Modificado', document_added: 'Documento adjuntado',
      driver_assigned: 'Chofer asignado', truck_assigned: 'Camión asignado',
    };

    const events = (logs as any[]).map((log: any) => ({
      action: ACTION_LABELS[log.action] || log.action,
      from: log.fromValue || null,
      to: log.toValue || null,
      reason: log.reason || null,
      user: log.user?.name || 'Sistema',
      company: log.user?.company?.name || null,
      date: new Date(log.createdAt).toISOString().replace('T', ' ').slice(0, 16),
    }));

    return JSON.stringify({ total: events.length, code: freight.code, events });
  }

  // ---- get_dashboard ----
  private async toolGetDashboard(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });

    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allCompanies = [companyId, ...memberCompanyIds].filter(Boolean);

    const where: any = {
      OR: [
        { originCompanyId: { in: allCompanies } },
        { destCompanyId: { in: allCompanies } },
        { assignments: { some: { transportCompanyId: { in: allCompanies }, status: { in: ['active', 'accepted'] } } } },
      ],
    };

    // Current month boundaries
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const [byStatus, monthFreights] = await Promise.all([
      // All freights grouped by status
      this.prisma.freight.groupBy({ by: ['status'], where, _count: true }),
      // This month's freights with items for tonnage
      this.prisma.freight.findMany({
        where: { ...where, createdAt: { gte: monthStart, lte: monthEnd } },
        select: { id: true, status: true, items: { select: { tons: true } } },
      }),
    ]);

    const STATUS_LABELS: Record<string, string> = {
      pending_assignment: 'Pend. asignación', assigned: 'Asignado', accepted: 'Aceptado',
      in_progress: 'En viaje', loaded: 'Cargado', finished: 'Completado',
      canceled: 'Cancelado', rejected: 'Rechazado',
    };

    const statusSummary = byStatus.map((s: any) => ({
      status: STATUS_LABELS[s.status] || s.status,
      count: s._count,
    }));

    const totalActive = byStatus
      .filter((s: any) => !['finished', 'canceled', 'rejected'].includes(s.status))
      .reduce((sum: number, s: any) => sum + s._count, 0);

    const monthTons = monthFreights.reduce((sum: number, f: any) =>
      sum + (f.items || []).reduce((s: number, i: any) => s + (Number(i.tons) || 0), 0), 0);
    const monthCompleted = monthFreights.filter((f: any) => f.status === 'finished').length;
    const monthCancelled = monthFreights.filter((f: any) => f.status === 'canceled').length;

    return JSON.stringify({
      activeFreights: totalActive,
      byStatus: statusSummary,
      month: {
        name: now.toLocaleString('es', { month: 'long', year: 'numeric' }),
        totalFreights: monthFreights.length,
        totalTons: Math.round(monthTons * 10) / 10,
        completed: monthCompleted,
        canceled: monthCancelled,
      },
    });
  }

  // ---- update_field ----
  private async toolUpdateField(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa productora.' });

    const field = await this.prisma.field.findFirst({
      where: {
        companyId: producerCompanyId,
        active: true,
        name: { contains: input.fieldName, mode: 'insensitive' },
      },
    });
    if (!field) return JSON.stringify({ error: `No se encontró el campo "${input.fieldName}".` });

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (!lat || !lng) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        lat = lat || st.lastLocation.lat;
        lng = lng || st.lastLocation.lng;
      }
    }

    const changes: string[] = [];
    const dto: any = {};
    if (input.address) { dto.address = input.address; changes.push(`Dirección: ${input.address}`); }
    if (lat) { dto.lat = lat; changes.push(`Latitud: ${lat}`); }
    if (lng) { dto.lng = lng; changes.push(`Longitud: ${lng}`); }

    if (changes.length === 0) {
      return JSON.stringify({ error: 'No se indicaron campos a modificar. Puede cambiar: address, lat, lng.' });
    }

    return this.stageAction(session, 'update_field', {
      fieldId: field.id, fieldName: field.name, dto, producerCompanyId,
    }, `Modificar campo "${field.name}"\n${changes.join('\n')}`);
  }

  // ---- update_lot ----
  private async toolUpdateLot(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa productora.' });

    const lot = await this.prisma.lot.findFirst({
      where: {
        companyId: producerCompanyId,
        active: true,
        name: { contains: input.lotName, mode: 'insensitive' },
      },
      include: { field: { select: { id: true, name: true } } },
    });
    if (!lot) return JSON.stringify({ error: `No se encontró el lote "${input.lotName}".` });

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (!lat || !lng) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        lat = lat || st.lastLocation.lat;
        lng = lng || st.lastLocation.lng;
      }
    }

    const changes: string[] = [];
    const dto: any = {};
    if (input.hectares) { dto.hectares = input.hectares; changes.push(`Hectáreas: ${input.hectares}`); }
    if (lat) { dto.lat = lat; changes.push(`Latitud: ${lat}`); }
    if (lng) { dto.lng = lng; changes.push(`Longitud: ${lng}`); }

    if (changes.length === 0) {
      return JSON.stringify({ error: 'No se indicaron campos a modificar. Puede cambiar: hectares, lat, lng.' });
    }

    return this.stageAction(session, 'update_lot', {
      fieldId: lot.field.id, lotId: lot.id, lotName: lot.name, fieldName: lot.field.name, dto, producerCompanyId,
    }, `Modificar lote "${lot.name}" (campo "${lot.field.name}")\n${changes.join('\n')}`);
  }

  // ---- reactivate_user ----
  private async toolReactivateUser(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden reactivar usuarios.' });
    }
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: false,
        user: {
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontró un usuario inactivo "${searchTerm}" en su empresa.` });
    }

    return this.stageAction(session, 'reactivate_user', {
      membershipId: membership.id,
      targetUserId: membership.user.id,
      userName: membership.user.name,
    }, `Reactivar usuario "${membership.user.name}" en su empresa`);
  }

  // ---- Helper: store _pendingSelection for interactive list ----
  private async storePendingSelection(
    session: any,
    items: { id: string; title: string; description?: string }[],
    config: { headerText: string; listButtonLabel: string; sectionTitle: string },
    purpose: string,
    extraJson?: Record<string, any>,
  ): Promise<string> {
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const currentState = (freshSession?.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...currentState,
          _pendingSelection: { items, config, purpose },
        },
      },
    });
    return JSON.stringify({
      total: items.length,
      message: `Se presento lista interactiva de ${items.length} elemento(s). Espere a que seleccione uno.`,
      _selectionSent: true,
      ...extraJson,
    });
  }

  // ---- get_freight_detail ----
  private async toolGetFreightDetail(input: any, user: any): Promise<string> {
    // Use resolveFreightWithAccess for unified access control (includes driver check)
    const accessResult = await this.resolveFreightWithAccess(input.code, user);
    if (accessResult.error) return JSON.stringify({ error: accessResult.error });

    // Fetch full detail data
    const freight = await this.prisma.freight.findUnique({
      where: { id: accessResult.freight.id },
      include: {
        items: true,
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { id: true, name: true } },
            driver: { select: { name: true } },
            truck: { select: { plate: true } },
          },
        },
      },
    });

    if (!freight) {
      return JSON.stringify({ error: `No se encontró el flete ${input.code}` });
    }

    // M1: Determine if user is only a transporter/driver (not origin/dest company)
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const isOriginOrDest = allUserCompanies.some(c =>
      c === freight.originCompanyId || c === freight.destCompanyId);

    const assignment = freight.assignments[0];
    const originName = (freight as any).originName || freight.originCompany?.name || 'N/A';
    const destName = (freight as any).destName || freight.destCompany?.name || 'N/A';
    const oLat = (freight as any).originLat ? Number((freight as any).originLat) : null;
    const oLng = (freight as any).originLng ? Number((freight as any).originLng) : null;
    const dLat = (freight as any).destLat ? Number((freight as any).destLat) : null;
    const dLng = (freight as any).destLng ? Number((freight as any).destLng) : null;

    // Build map link if coordinates available
    let mapLink: string | null = null;
    if (oLat && oLng) {
      const p = new URLSearchParams();
      p.set('lat', oLat.toFixed(6)); p.set('lng', oLng.toFixed(6)); p.set('n', originName.slice(0, 60));
      if (dLat && dLng) { p.set('dlat', dLat.toFixed(6)); p.set('dlng', dLng.toFixed(6)); p.set('dn', destName.slice(0, 60)); }
      mapLink = `${APP_URL}/ver-mapa?${p.toString()}`;
    }

    return JSON.stringify({
      code: freight.code,
      status: freight.status,
      items: freight.items.map((i: any) => ({ grain: i.grain, tons: i.tons })),
      origin: originName,
      dest: destName,
      date: freight.loadDate ? new Date(freight.loadDate).toISOString().split('T')[0] : null,
      time: (freight as any).loadTime || null,
      transporter: assignment?.transportCompany?.name || 'Sin asignar',
      driver: assignment?.driver?.name || null,
      truck: assignment?.truck?.plate || null,
      // Hide internal notes from pure transporters/drivers
      notes: isOriginOrDest ? ((freight as any).notes || null) : null,
      link: `${APP_URL}/freights/${freight.id}`,
      mapLink,
    });
  }

  // ---- search_plants ----
  private async toolSearchPlants(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No es productor', plants: [] });
    }

    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId, active: true },
      select: { plantCompanyId: true },
      take: 500,
    });

    const plantCompanyIds = [...new Set(accessRecords.map(ar => ar.plantCompanyId))];
    if (plantCompanyIds.length === 0) {
      return JSON.stringify({ plants: [], message: 'No tiene plantas habilitadas' });
    }

    const companies = await this.prisma.company.findMany({
      where: { id: { in: plantCompanyIds }, active: true },
      select: {
        id: true, name: true,
        plants: { where: { active: true }, select: { id: true, name: true } },
      },
      take: 50,
    });

    let filtered = companies;
    let matchType: string | undefined;
    if (input.query) {
      const fuzzyResults = fuzzySearch(input.query, companies, (c) => c.name, { threshold: 0.55, maxResults: 10 });
      matchType = classifyFuzzyResult(fuzzyResults);
      filtered = fuzzyResults.map(r => r.item) as any;
    }

    if (filtered.length === 0) {
      return JSON.stringify({ plants: [], message: 'No se encontraron plantas' });
    }

    // If exact/confident match on a single plant, return data directly for AI to use
    if (matchType === 'exact' || (matchType === 'confident' && filtered.length === 1)) {
      const c = filtered[0];
      return JSON.stringify({
        plants: [{ companyId: c.id, companyName: c.name, branches: (c as any).plants.map((b: any) => ({ id: b.id, name: b.name })) }],
        matchType,
      });
    }

    const items = filtered.map((c: any) => ({
      id: `plant:${c.id}`,
      title: c.name.slice(0, 24),
      description: `${c.plants?.length || 0} sucursal${c.plants?.length !== 1 ? 'es' : ''}`.slice(0, 72),
    }));

    // Include branch data in extraJson so AI has it for follow-up
    const plantsData = filtered.map((c: any) => ({
      companyId: c.id, companyName: c.name,
      branches: c.plants.map((b: any) => ({ id: b.id, name: b.name })),
    }));

    return this.storePendingSelection(session, items, {
      headerText: '🏢 Plantas disponibles.\nSeleccione una:',
      listButtonLabel: 'Ver plantas',
      sectionTitle: 'PLANTAS',
    }, 'plant_info', { plants: plantsData, matchType });
  }

  // ---- list_lots ----
  private async toolListLots(user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No es productor', lots: [] });
    }

    const lots = await this.prisma.lot.findMany({
      where: { companyId: producerCompanyId, active: true },
      include: { field: { select: { id: true, name: true, lat: true, lng: true } } },
      take: 100,
    });

    if (lots.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay lotes registrados.' });
    }

    const items = lots.map((l: any) => ({
      id: `lot:${l.id}`,
      title: (l.name || 'Sin nombre').slice(0, 24),
      description: (l.field?.name || 'Sin campo').slice(0, 72),
    }));

    // Include lot data with mapLink instead of raw coords
    const lotsData = lots.map((l: any) => {
      const lLat = l.lat ? Number(l.lat) : (l.field?.lat ? Number(l.field.lat) : null);
      const lLng = l.lng ? Number(l.lng) : (l.field?.lng ? Number(l.field.lng) : null);
      let mapLink: string | null = null;
      if (lLat && lLng) {
        const p = new URLSearchParams();
        p.set('lat', lLat.toFixed(6)); p.set('lng', lLng.toFixed(6)); p.set('n', (l.name || 'Lote').slice(0, 60));
        mapLink = `${APP_URL}/ver-mapa?${p.toString()}`;
      }
      return { id: l.id, name: l.name, fieldName: l.field?.name || null, mapLink };
    });

    return this.storePendingSelection(session, items, {
      headerText: '🗺️ Lotes registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver lotes',
      sectionTitle: 'LOTES',
    }, 'lot_info', { lots: lotsData });
  }

  // ---- prepare_freight ----
  private async toolPrepareFreight(input: any, user: any, session: any): Promise<string> {
    // Input validation
    if (!input.grain || typeof input.grain !== 'string') {
      return JSON.stringify({ error: 'Falta el tipo de grano (grain).' });
    }
    if (!input.tons || isNaN(Number(input.tons)) || Number(input.tons) <= 0) {
      return JSON.stringify({ error: 'Falta la cantidad de toneladas (tons) o es inválida.' });
    }
    if (!input.loadDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.loadDate)) {
      return JSON.stringify({ error: 'Falta la fecha de carga (loadDate) o formato inválido. Usa YYYY-MM-DD.' });
    }
    if (!input.loadTime || !/^\d{2}:\d{2}$/.test(input.loadTime)) {
      return JSON.stringify({ error: 'Falta la hora de carga (loadTime) o formato inválido. Usa HH:MM.' });
    }
    if (input.truckCount !== undefined && (isNaN(Number(input.truckCount)) || Number(input.truckCount) < 1)) {
      return JSON.stringify({ error: 'truckCount debe ser un número >= 1.' });
    }

    // Custom destination requires location
    if (!input.destPlantId && input.destName && (!input.customDestLat || !input.customDestLng)) {
      return JSON.stringify({
        error: 'Para destino personalizado, la ubicación es obligatoria. Solicite al usuario que comparta su ubicación de WhatsApp o use generate_location_link con purpose "destination".',
      });
    }
    // Custom origin requires location
    if (!input.originLotId && input.customOriginName && (!input.customOriginLat || !input.customOriginLng)) {
      return JSON.stringify({
        error: 'Para origen personalizado, la ubicación es obligatoria. Solicite al usuario que comparta su ubicación de WhatsApp o use generate_location_link con purpose "origin".',
      });
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
      IMPORTANT: 'El flete NO fue creado todavía. Mostra el resumen y pregunta al usuario si confirma. Se enviaran botones CONFIRMAR/CANCELAR automáticamente.',
    });
  }

  // ---- confirm_create_freight ----
  private async toolConfirmCreateFreight(user: any, synUser: any, session: any): Promise<string> {
    // Reload session from DB to get pendingFreight saved by prepare_freight
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const state = (freshSession?.flowState as any) || {};
    const pending = state.pendingFreight;

    this.logger.log(`confirm_create_freight — pendingFreight: ${pending ? JSON.stringify(pending).slice(0, 200) : 'NULL'}`);

    if (!pending) {
      return JSON.stringify({ error: 'No hay un flete pendiente de confirmación. Primero usa prepare_freight.' });
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
        this.logger.log(`Lot coords: lot(${lot.lat},${lot.lng}) field(${lot.field?.lat},${lot.field?.lng}) → resolved(${lat},${lng})`);
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
        // No coordinates available — leave as null, freight service handles it
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

    this.logger.log(`Creating freight with DTO: ${JSON.stringify(dto).slice(0, 300)}`);
    const freight = await this.freights.create(dto, producerSynUser);
    this.logger.log(`Freight created: ${(freight as any).code}`);

    // Clear pending freight — re-read session to avoid overwriting aiMessages updated by chat()
    const freshSess = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const latestState = (freshSess?.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: { ...latestState, pendingFreight: null },
      },
    });

    return JSON.stringify({
      status: 'created',
      code: (freight as any).code,
      link: `${APP_URL}/freights/${(freight as any).id}`,
    });
  }

  // ---- confirm_action (generic dispatcher) ----
  private async toolConfirmAction(user: any, synUser: any, session: any): Promise<string> {
    // Atomic consume: clear pendingAction and return old flowState in one query.
    // Only one concurrent request can succeed (WHERE checks pendingAction exists).
    const rows = await this.prisma.$queryRaw<any[]>`
      UPDATE "whatsapp_sessions"
      SET "flow_state" = "flow_state" #- '{pendingAction}' #- '{_pendingButtons}'
      WHERE "id" = ${session.id}
        AND "flow_state" ? 'pendingAction'
      RETURNING "flow_state" #- '{pendingAction}' #- '{_pendingButtons}' AS "cleaned_state"
    `;

    // Read the pending action from the session snapshot (loaded before this atomic clear)
    const state = (session.flowState as any) || {};
    const pending = state.pendingAction;

    if (!rows.length || !pending) {
      return JSON.stringify({ error: 'No hay una acción pendiente de confirmación.' });
    }

    const preExecState = rows[0].cleaned_state || {};
    const { tool, params } = pending;
    this.logger.log(`confirm_action — dispatching: ${tool}`);

    let result: string;

    try {
      switch (tool) {
        case 'accept_freight':
          await this.freights.respond(params.freightId, { action: 'accepted' } as any, synUser);
          result = JSON.stringify({ status: 'accepted', code: params.code });
          break;

        case 'reject_freight':
          await this.freights.respond(params.freightId, { action: 'rejected', reason: params.reason } as any, synUser);
          result = JSON.stringify({ status: 'rejected', code: params.code });
          break;

        case 'start_freight':
          await this.freights.start(params.freightId, synUser);
          result = JSON.stringify({ status: 'started', code: params.code });
          // Fire-and-forget: send tracking links + GPS request to driver
          this.sendPostStartTrackingMessages(params.freightId, params.code, user).catch(err =>
            this.logger.error(`Post-start tracking failed for ${params.code}: ${err.message}`),
          );
          break;

        case 'confirm_loaded':
          await this.freights.confirmLoaded(params.freightId, synUser, params.tons);
          result = JSON.stringify({ status: 'loaded', code: params.code, tons: params.tons });
          break;

        case 'confirm_finished':
          await this.freights.confirmFinished(params.freightId, synUser);
          result = JSON.stringify({ status: 'finished', code: params.code });
          break;

        case 'cancel_freight':
          await this.freights.cancel(params.freightId, { reason: params.reason } as any, synUser);
          result = JSON.stringify({ status: 'canceled', code: params.code });
          break;

        case 'assign_transporter': {
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          const dto: any = { transportCompanyId: params.transporterCompanyId };
          if (params.truckId) dto.truckId = params.truckId;
          if (params.driverId) dto.driverId = params.driverId;
          // Multi-truck freights must use assignTruck() — assign() rejects them
          const frCheck = await this.prisma.freight.findUnique({ where: { id: params.freightId }, select: { isMultiTruck: true } });
          if (frCheck?.isMultiTruck) {
            await this.freights.assignTruck(params.freightId, dto, plantSyn);
          } else {
            await this.freights.assign(params.freightId, dto, plantSyn);
          }
          result = JSON.stringify({ status: 'done', code: params.code, transporter: params.transporterName });
          break;
        }

        case 'assign_truck_to_trip': {
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          const dto: any = { truckId: params.truckId };
          if (params.driverId) dto.driverId = params.driverId;
          await this.freights.updateAssignment(params.freightId, params.assignmentId, dto, plantSyn);
          result = JSON.stringify({ status: 'done', code: params.code, truck: params.truckDisplay });
          break;
        }

        case 'assign_truck_to_freight': {
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          const truckDto: any = { transportCompanyId: params.transporterCompanyId };
          if (params.truckId) truckDto.truckId = params.truckId;
          if (params.driverId) truckDto.driverId = params.driverId;
          if (params.tons) truckDto.tons = params.tons;
          await this.freights.assignTruck(params.freightId, truckDto, plantSyn);
          result = JSON.stringify({
            status: 'assigned', code: params.code,
            tripNumber: params.nextTripNumber,
            remaining: params.remaining,
            message: params.remaining > 0
              ? `Viaje #${params.nextTripNumber} asignado. Quedan ${params.remaining} viaje(s) sin asignar.`
              : `Viaje #${params.nextTripNumber} asignado. Todos los camiones del flete están asignados.`,
          });
          break;
        }

        case 'update_user_role': {
          // Validate role value before writing
          const validUcRoles = ['operario', 'gerente', 'chofer'];
          if (!validUcRoles.includes(params.newRole)) {
            throw new Error(`Rol inválido: ${params.newRole}. Valores válidos: ${validUcRoles.join(', ')}`);
          }
          // Re-validate membership still exists and belongs to the expected company
          const membership = await this.prisma.userCompany.findFirst({
            where: { id: params.membershipId, companyId: params.companyId, userId: params.targetUserId, active: true },
          });
          if (!membership) throw new Error('Membresía no encontrada o ya fue modificada');
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { role: params.newRole } });
          const roleMapping: Record<string, string> = { gerente: 'admin', operario: 'operator', chofer: 'operator' };
          await this.prisma.user.update({ where: { id: params.targetUserId }, data: { role: (roleMapping[params.newRole] || 'operator') as any } });
          result = JSON.stringify({ status: 'done', user: params.userName, newRole: params.newRole });
          break;
        }

        case 'deactivate_user': {
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { active: false } });
          const otherActive = await this.prisma.userCompany.count({ where: { userId: params.targetUserId, active: true } });
          if (otherActive === 0) {
            await this.prisma.user.update({ where: { id: params.targetUserId }, data: { active: false } });
          }
          result = JSON.stringify({ status: 'done', user: params.userName });
          break;
        }

        case 'create_field': {
          const field = await this.fieldsService.createField(params.producerSynUser, params.dto);
          result = JSON.stringify({ status: 'created', field: { id: field.id, name: field.name } });
          break;
        }

        case 'create_lot': {
          const lot = await this.fieldsService.createLot(params.producerSynUser, params.fieldId, params.dto);
          result = JSON.stringify({ status: 'created', lot: { id: lot.id, name: lot.name } });
          break;
        }

        case 'create_truck': {
          const truck = await this.trucksService.create(params.dto as any, params.actionSynUser);
          result = JSON.stringify({ status: 'created', truck: { id: (truck as any).id, plate: (truck as any).plate } });
          break;
        }

        case 'create_user': {
          const newUser = await this.adminService.createUser(params.dto, params.passwordHash);
          result = JSON.stringify({ status: 'created', user: { name: (newUser as any).name, email: (newUser as any).email, role: params.roleLabel } });
          break;
        }

        case 'attach_document': {
          this.logger.log(`attach_document freightId=${params.freightId} code=${params.code} doc=${params.document?.name}`);
          const doc = await this.freights.addDocument(params.freightId, {
            name: params.document.name,
            url: params.document.url,
            type: params.document.type,
            step: params.step || null,
          }, synUser);
          this.logger.log(`attach_document created doc: ${(doc as any).id}`);
          result = JSON.stringify({ status: 'attached', code: params.code, document: params.document.name, docId: (doc as any).id });
          break;
        }

        case 'update_freight': {
          const updateResult = await this.freights.updateFreight(params.freightId, params.dto, synUser);
          if ((updateResult as any).pendingChangeCreated) {
            result = JSON.stringify({ status: 'pending_approval', code: params.code, message: `Flete ${params.code}: algunos cambios requieren aprobación. Se notificó a la empresa correspondiente.` });
          } else {
            result = JSON.stringify({ status: 'updated', code: params.code, message: `Flete ${params.code} modificado exitosamente.` });
          }
          break;
        }

        case 'duplicate_freight': {
          const orig = params.originalFreight;
          const producerCompanyId = this.resolveProducerCompanyId(user);
          const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };
          const createDto: any = {
            items: [{ grain: orig.grain, tons: orig.tons }],
            loadDate: params.loadDate,
            loadTime: params.loadTime,
            truckCount: orig.truckCount || 1,
            notes: orig.notes,
          };
          if (orig.destPlantId) createDto.destPlantId = orig.destPlantId;
          else if (orig.destCompanyId) createDto.destCompanyId = orig.destCompanyId;
          else if (orig.customDestName) createDto.customDestName = orig.customDestName;
          if (orig.originLotId) createDto.originLotId = orig.originLotId;
          else if (orig.customOriginName) createDto.customOriginName = orig.customOriginName;
          if (orig.originLat && orig.originLng) { createDto.overrideOriginLat = orig.originLat; createDto.overrideOriginLng = orig.originLng; }
          if (orig.destLat && orig.destLng) { createDto.overrideDestLat = orig.destLat; createDto.overrideDestLng = orig.destLng; }
          const newFreight = await this.freights.create(createDto, producerSynUser);
          result = JSON.stringify({ status: 'duplicated', originalCode: params.originalCode, newCode: (newFreight as any).code, link: `${APP_URL}/freights/${(newFreight as any).id}` });
          break;
        }

        case 'update_field': {
          const fieldSynUser = { ...synUser, companyId: params.producerCompanyId, companyType: 'producer', userType: 'producer' };
          await this.fieldsService.updateField(fieldSynUser, params.fieldId, params.dto);
          result = JSON.stringify({ status: 'updated', fieldName: params.fieldName, message: `Campo "${params.fieldName}" modificado exitosamente.` });
          break;
        }

        case 'update_lot': {
          const lotSynUser = { ...synUser, companyId: params.producerCompanyId, companyType: 'producer', userType: 'producer' };
          await this.fieldsService.updateLot(lotSynUser, params.fieldId, params.lotId, params.dto);
          result = JSON.stringify({ status: 'updated', lotName: params.lotName, fieldName: params.fieldName, message: `Lote "${params.lotName}" modificado exitosamente.` });
          break;
        }

        case 'reactivate_user': {
          await this.prisma.userCompany.update({
            where: { id: params.membershipId },
            data: { active: true },
          });
          await this.prisma.user.update({
            where: { id: params.targetUserId },
            data: { active: true },
          });
          result = JSON.stringify({ status: 'reactivated', userName: params.userName, message: `Usuario "${params.userName}" reactivado exitosamente.` });
          break;
        }

        case 'authorize_freight': {
          await this.freights.authorize(params.freightId, synUser);
          result = JSON.stringify({ status: 'authorized', code: params.code, message: `Flete ${params.code} autorizado.` });
          break;
        }

        case 'approve_pending_change': {
          await this.freights.approvePendingChange(params.freightId, params.changeId, synUser);
          result = JSON.stringify({ status: 'approved', code: params.code, message: `Cambio aprobado en flete ${params.code}.` });
          break;
        }

        case 'reject_pending_change': {
          await this.freights.rejectPendingChange(params.freightId, params.changeId, synUser, params.reason);
          result = JSON.stringify({ status: 'rejected', code: params.code, message: `Cambio rechazado en flete ${params.code}.` });
          break;
        }

        case 'respond_trip': {
          await this.freights.respondTrip(params.freightId, params.assignmentId, { action: params.action, reason: params.reason }, synUser);
          const label = params.action === 'accepted' ? 'aceptado' : 'rechazado';
          result = JSON.stringify({ status: label, code: params.code, message: `Viaje de ${params.code} ${label}.` });
          break;
        }

        case 'start_trip': {
          await this.freights.startTrip(params.freightId, params.assignmentId, synUser);
          result = JSON.stringify({ status: 'started', code: params.code, message: `Viaje de ${params.code} iniciado.` });
          break;
        }

        case 'confirm_trip_loaded': {
          await this.freights.confirmTripLoaded(params.freightId, params.assignmentId, synUser, params.loadedTons);
          result = JSON.stringify({ status: 'loaded', code: params.code, message: `Carga confirmada para viaje de ${params.code}.` });
          break;
        }

        case 'confirm_trip_finished': {
          await this.freights.confirmTripFinished(params.freightId, params.assignmentId, synUser);
          result = JSON.stringify({ status: 'finished', code: params.code, message: `Entrega confirmada para viaje de ${params.code}.` });
          break;
        }

        case 'cancel_assignment': {
          await this.freights.cancelAssignment(params.freightId, params.assignmentId, params.reason, synUser);
          result = JSON.stringify({ status: 'canceled', code: params.code, message: `Asignación cancelada en flete ${params.code}.` });
          break;
        }

        case 'update_assignment': {
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          await this.freights.updateAssignment(params.freightId, params.assignmentId, params.dto, plantSyn);
          result = JSON.stringify({ status: 'updated', code: params.code, message: `Viaje de ${params.code} actualizado.` });
          break;
        }

        case 'create_driver': {
          const driverSyn = { ...synUser, companyId: params.companyId };
          const driver = await this.trucksService.createDriver({ name: params.name, phone: params.phone }, driverSyn);
          result = JSON.stringify({ status: 'created', driver: { id: (driver as any).id, name: (driver as any).name }, message: `Chofer "${params.name}" registrado.` });
          break;
        }

        case 'update_profile': {
          const dto: any = {};
          if (params.name) dto.name = params.name;
          if (params.email) dto.email = params.email;
          if (params.phone) dto.phone = params.phone;
          await this.adminService.updateSelf(params.userId, dto);
          result = JSON.stringify({ status: 'updated', message: 'Perfil actualizado exitosamente.' });
          break;
        }

        default:
          result = JSON.stringify({ error: `Acción no reconocida: ${tool}` });
      }
    } catch (e) {
      this.logger.error(`confirm_action dispatch error (${tool}): ${e.message}`, e.stack?.slice(0, 300));
      // Restore pendingAction so user can retry
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: { ...preExecState, pendingAction: pending } },
      }).catch(e => this.logger.warn(e.message));
      // H2: Sanitize — map known error patterns to user-friendly messages
      const msg = String(e.message || '');
      const SAFE_ERRORS: [RegExp, string][] = [
        [/no encontrad/i, 'El recurso no fue encontrado.'],
        [/no se puede cancelar/i, msg],
        [/estado.*inv[aá]lido|transici[oó]n/i, 'La operación no es valida en el estado actual del flete.'],
        [/ya.*asignad|ya.*acept/i, 'La acción ya fue realizada previamente.'],
        [/permiso|forbidden|autoriza/i, 'No tiene permisos para realizar esta acción.'],
        [/chofer no encontrado/i, 'El chofer indicado no fue encontrado en la empresa.'],
        [/empresa.*no.*encontr/i, 'La empresa indicada no fue encontrada.'],
        [/membres[ií]a/i, 'El usuario ya no pertenece a la empresa.'],
      ];
      const safeMsg = SAFE_ERRORS.find(([re]) => re.test(msg))?.[1] || 'No se pudo ejecutar la acción. Intente nuevamente.';
      return JSON.stringify({ error: safeMsg });
    }

    // pendingAction already cleared pre-execution (M2). Clean up pendingDocument if attach_document.
    if (tool === 'attach_document') {
      const { pendingDocument: _pd, ...finalState } = preExecState;
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: finalState },
      });
    }

    return result;
  }

  // ---- accept_freight ----
  private async toolAcceptFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'accept_freight', {
      freightId: freight.id, code: freight.code,
    }, `Aceptar flete ${freight.code}`);
  }

  // ---- reject_freight ----
  private async toolRejectFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'reject_freight', {
      freightId: freight.id, code: freight.code, reason: input.reason,
    }, `Rechazar flete ${freight.code} · Motivo: ${input.reason}`);
  }

  // ---- start_freight ----
  private async toolStartFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'start_freight', {
      freightId: freight.id, code: freight.code,
    }, `Iniciar viaje del flete ${freight.code}`);
  }

  // ---- confirm_loaded ----
  private async toolConfirmLoaded(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'confirm_loaded', {
      freightId: freight.id, code: freight.code, tons: input.tons,
    }, `Confirmar carga del flete ${freight.code} · ${input.tons} tn`);
  }

  // ---- confirm_finished ----
  private async toolConfirmFinished(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'confirm_finished', {
      freightId: freight.id, code: freight.code,
    }, `Confirmar entrega del flete ${freight.code}`);
  }

  // ---- cancel_freight ----
  private async toolCancelFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    if (['in_progress', 'loaded'].includes(freight.status)) {
      return JSON.stringify({ error: `No se puede cancelar ${input.code} en estado ${freight.status}` });
    }

    return this.stageAction(session, 'cancel_freight', {
      freightId: freight.id, code: freight.code, reason: input.reason,
    }, `Cancelar flete ${freight.code} · Motivo: ${input.reason}`);
  }

  // ======================== FIELD & LOT TOOLS ===========================

  // ---- list_fields ----
  private async toolListFields(user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No es productor', fields: [] });
    const fields = await this.prisma.field.findMany({
      where: { companyId: producerCompanyId, active: true },
      include: { lots: { where: { active: true } } },
      orderBy: { name: 'asc' },
    });

    if (fields.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay campos registrados. Puede crear uno con create_field.' });
    }

    const items = fields.map((f: any) => ({
      id: `field:${f.id}`,
      title: (f.name || 'Sin nombre').slice(0, 24),
      description: `${f.lots?.length || 0} lote${f.lots?.length !== 1 ? 's' : ''}${f.address ? ' · ' + f.address : ''}`.slice(0, 72),
    }));

    // Include full field data so AI can answer follow-up questions (mapLink instead of raw coords)
    const fieldsData = fields.map((f: any) => {
      const fLat = f.lat ? Number(f.lat) : null;
      const fLng = f.lng ? Number(f.lng) : null;
      let mapLink: string | null = null;
      if (fLat && fLng) {
        const p = new URLSearchParams();
        p.set('lat', fLat.toFixed(6)); p.set('lng', fLng.toFixed(6)); p.set('n', (f.name || 'Campo').slice(0, 60));
        mapLink = `${APP_URL}/ver-mapa?${p.toString()}`;
      }
      return {
        id: f.id, name: f.name, address: f.address, mapLink,
        lots: f.lots.map((l: any) => ({ id: l.id, name: l.name })),
      };
    });

    return this.storePendingSelection(session, items, {
      headerText: '🌾 Campos registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver campos',
      sectionTitle: 'CAMPOS',
    }, 'field_info', { fields: fieldsData });
  }

  // ---- create_field ----
  private async toolCreateField(input: any, user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (!lat || !lng) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        lat = lat || st.lastLocation.lat;
        lng = lng || st.lastLocation.lng;
      }
    }

    // Location is mandatory for field creation
    if (!lat || !lng) {
      return JSON.stringify({
        error: 'La ubicación es obligatoria para crear un campo. Solicite al usuario que comparta su ubicación de WhatsApp o use generate_location_link para generar el enlace del mapa.',
      });
    }

    const dto = { name: input.name, address: input.address || null, lat, lng };
    const summary = `Crear campo "${input.name}"${input.address ? ` en ${input.address}` : ''} (ubicación incluida)`;

    return this.stageAction(session, 'create_field', { producerSynUser, dto }, summary);
  }

  // ---- create_lot ----
  private async toolCreateLot(input: any, user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (!lat || !lng) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        lat = lat || st.lastLocation.lat;
        lng = lng || st.lastLocation.lng;
      }
    }

    // Location is mandatory for lot creation
    if (!lat || !lng) {
      return JSON.stringify({
        error: 'La ubicación es obligatoria para crear un lote. Solicite al usuario que comparta su ubicación de WhatsApp o use generate_location_link para generar el enlace del mapa.',
      });
    }

    // Resolve field name for summary
    const field = await this.prisma.field.findUnique({ where: { id: input.fieldId }, select: { name: true } });
    const dto = { name: input.name, hectares: input.hectares || null, lat, lng };
    const summary = `Crear lote "${input.name}" en campo "${field?.name || 'desconocido'}"${input.hectares ? ` (${input.hectares} ha)` : ''}`;

    return this.stageAction(session, 'create_lot', { producerSynUser, fieldId: input.fieldId, dto }, summary);
  }

  // ======================== TRUCK TOOLS ==================================

  // ---- list_trucks ----
  private async toolListTrucks(user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const trucks = await this.trucksService.list(synUser);

    if ((trucks as any[]).length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay camiones registrados. Puede crear uno con create_truck.' });
    }

    const items = (trucks as any[]).map((t: any) => ({
      id: `truck:${t.id}`,
      title: (t.plate || '').toUpperCase().slice(0, 24),
      description: `${[t.brand, t.model].filter(Boolean).join(' ')}${t.assignedUser?.name ? ' · ' + t.assignedUser.name : ''}`.slice(0, 72) || 'Sin detalle',
    }));

    return this.storePendingSelection(session, items, {
      headerText: '🚛 Camiones registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver camiones',
      sectionTitle: 'CAMIONES',
    }, 'truck_info');
  }

  // ---- create_truck ----
  private async toolCreateTruck(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden registrar camiones.' });
    }
    const synUser = this.buildSyntheticUser(user);
    const dto = { plate: input.plate, model: input.model || null };
    const summary = `Registrar camión ${input.plate}${input.model ? ` (${input.model})` : ''}`;

    return this.stageAction(session, 'create_truck', { dto, actionSynUser: synUser }, summary);
  }

  // ======================== USER TOOLS ===================================

  // ---- create_user ----
  private async toolCreateUser(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const companyType = this.resolveCompanyType(user);
    const targetCompanyId = producerCompanyId || user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, targetCompanyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden crear usuarios.' });
    }
    const primaryType = companyType.split(',')[0]?.trim() || 'producer';

    // Map Spanish role names to Prisma UserRole enum (admin | operator | platform_admin)
    const inputRole = input.role || 'operario';
    const roleToEnum: Record<string, string> = {
      admin: 'admin', gerente: 'admin',
      operario: 'operator', chofer: 'operator',
    };
    const prismaRole = roleToEnum[inputRole] || 'operator';

    // Hash password NOW so plaintext never sits in session flowState
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(input.password, 10);

    const dto: any = {
      name: input.name,
      email: input.email,
      password: 'placeholder', // required by DTO — actual hash passed separately
      phone: input.phone || null,
      role: prismaRole,
      companyId: producerCompanyId,
      userTypes: [primaryType],
      companyByType: { [primaryType]: producerCompanyId },
      roleByType: { [primaryType]: inputRole },
    };

    const summary = `Crear usuario "${input.name}" (${input.email}) con rol ${inputRole}`;
    return this.stageAction(session, 'create_user', { dto, passwordHash, roleLabel: inputRole }, summary);
  }

  // ======================== DOCUMENT ATTACHMENT TOOL =======================

  // ---- attach_document ----
  private async toolAttachDocument(input: any, user: any, synUser: any, session: any): Promise<string> {
    // Read pendingDocument from session
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const state = (freshSession?.flowState as any) || {};
    const pending = state.pendingDocument;

    if (!pending) {
      return JSON.stringify({ error: 'No hay archivo pendiente. El usuario debe enviar una imagen o documento primero.' });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const summary = `Adjuntar ${pending.type === 'photo' ? 'imagen' : 'documento'} "${pending.name}" a flete ${freight.code}`;

    return this.stageAction(session, 'attach_document', {
      freightId: freight.id,
      code: freight.code,
      document: pending,
      step: input.step || null,
    }, summary);
  }

  // ======================== LOCATION PICKER TOOL ==========================

  // ---- generate_location_link ----
  private async toolGenerateLocationLink(input: any, session: any): Promise<string> {
    const token = require('crypto').randomUUID();
    const purposeLabel = (input.purpose || 'campo').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
    const slug = `${purposeLabel}-${require('crypto').randomBytes(2).toString('hex')}`;
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const state = (freshSession?.flowState as any) || {};

    // Single write: save locationToken + _pendingButtons together
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          locationToken: {
            token,
            slug,
            purpose: input.purpose || 'general',
            createdAt: new Date().toISOString(),
          },
          _pendingButtons: [
            { id: 'location_done', title: 'UBICACIÓN LISTA' },
          ],
        },
      },
    });

    this.logger.log(`generate_location_link — slug=${slug}, sessionId=${session.id}`);

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/campo/${slug}/ubicacion`;

    const purposeLabels: Record<string, string> = {
      origin: 'origen del flete',
      destination: 'destino del flete',
      field: 'ubicación del campo',
      lot: 'ubicación del lote',
    };
    const label = purposeLabels[input.purpose] || 'ubicación';

    return JSON.stringify({
      url,
      message: `Abra el siguiente link para seleccionar el ${label} en el mapa. Una vez confirmada la ubicación, presione el botón.`,
    });
  }

  // ---- generate_tracking_link ----
  private async toolGenerateTrackingLink(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Codigo de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, shareToken: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });

    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access control (origin, dest, and transporter companies)
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    if (['finished', 'canceled'].includes(freight.status)) {
      return JSON.stringify({ error: `El flete ${code} ya está ${freight.status === 'finished' ? 'finalizado' : 'cancelado'}` });
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

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/${freight.code}/ubicacion?s=${token}`;

    return JSON.stringify({
      url,
      message: `Aquí tiene el enlace de seguimiento en vivo del flete ${code}. Ábralo para ver la ruta y posición del camión en tiempo real.`,
    });
  }

  // ---- generate_map_link ----
  private toolGenerateMapLink(input: any): string {
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (isNaN(lat) || isNaN(lng)) return JSON.stringify({ error: 'Coordenadas inválidas' });

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const params = new URLSearchParams();
    params.set('lat', lat.toFixed(6));
    params.set('lng', lng.toFixed(6));
    params.set('n', (input.name || 'Ubicación').slice(0, 60));
    if (input.destLat != null && input.destLng != null) {
      params.set('dlat', Number(input.destLat).toFixed(6));
      params.set('dlng', Number(input.destLng).toFixed(6));
      if (input.destName) params.set('dn', input.destName.slice(0, 60));
    }
    const url = `${frontendUrl}/ver-mapa?${params.toString()}`;

    return JSON.stringify({
      url,
      message: `Abra el link para ver la ubicación de ${input.name || 'este punto'} en el mapa Tolvink.`,
    });
  }

  // ---- generate_report_link ----
  private async toolGenerateReportLink(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Codigo de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, shareToken: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });

    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access control (origin, dest, and transporter companies)
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
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

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/${freight.code}/informe?s=${token}`;

    return JSON.stringify({
      url,
      message: `Aquí tiene el enlace para descargar el informe PDF del flete ${code}. Ábralo desde cualquier dispositivo.`,
    });
  }

  // ======================== MAP & LIVE LOCATION TOOLS =====================

  // ---- generate_daily_map_link ----
  private async toolGenerateDailyMapLink(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar la empresa activa.' });

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) return JSON.stringify({ error: 'Configuración del servidor incompleta.' });

    const token = createSignedToken({ uid: user.id, cid: companyId }, secret, 1440); // 24h

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/daily-map?t=${token}`;

    return JSON.stringify({
      url,
      message: 'Abra el siguiente link para ver el mapa con todos los fletes del día. Puede filtrar por estado y tocar cada marcador para ver detalles.',
    });
  }

  // ---- share_live_location ----
  private async toolShareLiveLocation(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Codigo de flete requerido' });

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

    const companyType = this.resolveCompanyType(user);
    const role = companyType.includes('chofer') ? 'chofer'
      : companyType.includes('transporter') ? 'transporter'
      : companyType.includes('plant') ? 'plant' : 'producer';

    const token = createSignedToken(
      { uid: user.id, cid: userCompanyId, fid: freight.id, role, name: user.name || 'Usuario' },
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
  private async toolViewLiveLocations(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Codigo de flete requerido' });

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
      { uid: user.id, cid: userCompanyId, fid: freight.id },
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
  private async toolRequestLocation(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Codigo de flete requerido' });

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
    const msg = `*Solicitud de ubicación*\n${requesterName} solicita tu ubicación para el flete ${freight.code} (${freight.originName} \u2192 ${freight.destName}).\n\nEnvia tu ubicación en este chat (adjuntar \u2192 Ubicacion).`;

    let sent = 0;
    for (const [, target] of allTargets) {
      await this.wa.sendText(target.phone, msg).catch(() => {});
      sent++;
    }

    return JSON.stringify({
      status: 'ok',
      message: `Solicitud enviada a ${sent} participante${sent > 1 ? 's' : ''}`,
      sent,
    });
  }

  // ======================== POST-START TRACKING MESSAGES =================

  /**
   * Fire-and-forget: after a freight is started, send tracking links to stakeholders
   * and prompt the driver to share GPS location.
   */
  private async sendPostStartTrackingMessages(freightId: string, code: string, triggerUser: any): Promise<void> {
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
      shareToken = require('crypto').randomUUID();
      await this.prisma.freight.update({ where: { id: freightId }, data: { shareToken } });
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
        + `Puede enviar su ubicación en este chat (adjuntar \u2192 Ubicacion) para que las empresas sigan el viaje.\n\n`
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
          { companyId: { in: Array.from(companyIds) } },
          { memberships: { some: { companyId: { in: Array.from(companyIds) }, active: true } } },
        ],
      },
      select: { phone: true, id: true, companyId: true },
      take: 100,
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

      const trackMsg = `*Flete ${freight.code} en camino*\n${freight.originName} → ${freight.destName}\n\n`
        + `Seguimiento en vivo: ${liveViewUrl || trackingUrl}`;

      sends.push(this.wa.sendText(s.phone, trackMsg));
    }

    // Send all messages in parallel
    await Promise.allSettled(sends);
  }

  // ======================== TRANSPORTER ASSIGNMENT TOOLS ==================

  // ---- list_transporters ----
  private async toolListTransporters(user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!companyType.includes('plant') && !companyType.includes('producer')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta o productor pueden listar transportistas.' });
    }

    const ownCompanyId = user.activeCompanyId || user.companyId;
    let hasOwnFleet = false;
    if (ownCompanyId) {
      const ownCompany = await this.prisma.company.findUnique({
        where: { id: ownCompanyId },
        select: { name: true, hasInternalFleet: true },
      });
      if (ownCompany?.hasInternalFleet) hasOwnFleet = true;
    }

    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { OR: [{ producerCompanyId: ownCompanyId }, { plantCompanyId: ownCompanyId }], active: true },
      select: { producerCompanyId: true, plantCompanyId: true },
      take: 500,
    });
    const relatedCompanyIds = [...new Set(accessRecords.map(a =>
      a.producerCompanyId === ownCompanyId ? a.plantCompanyId : a.producerCompanyId,
    ))];
    const freightRelated = await this.prisma.freightAssignment.findMany({
      where: {
        transportCompanyId: { not: null },
        freight: { OR: [{ originCompanyId: ownCompanyId }, { destCompanyId: ownCompanyId }] },
      },
      distinct: ['transportCompanyId'],
      select: { transportCompanyId: true },
    });
    for (const fr of freightRelated) {
      if (fr.transportCompanyId) relatedCompanyIds.push(fr.transportCompanyId);
    }
    const uniqueIds = [...new Set(relatedCompanyIds)];

    const transporters = uniqueIds.length > 0
      ? await this.prisma.company.findMany({
          where: {
            id: { in: uniqueIds }, active: true,
            OR: [{ type: 'transporter' }, { types: { array_contains: ['transporter'] } }],
          },
          select: { id: true, name: true, phone: true },
          orderBy: { name: 'asc' },
          take: 50,
        })
      : [];

    const result: any[] = transporters.map(c => ({ id: c.id, name: c.name, phone: c.phone }));

    if (hasOwnFleet && ownCompanyId && !result.some(r => r.id === ownCompanyId)) {
      const ownCompany = await this.prisma.company.findUnique({
        where: { id: ownCompanyId },
        select: { id: true, name: true, phone: true },
      });
      if (ownCompany) {
        result.unshift({ id: ownCompany.id, name: `${ownCompany.name} (Flota interna)`, phone: ownCompany.phone, ownFleet: true });
      }
    }

    if (result.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay transportistas disponibles.' });
    }

    const items = result.map(c => ({
      id: `transporter:${c.id}`,
      title: c.name.slice(0, 24),
      description: (c.phone || 'Sin teléfono').slice(0, 72),
    }));

    const extraJson: any = { transporters: result };
    if (hasOwnFleet) {
      extraJson.NOTA = 'Este usuario tiene FLOTA INTERNA. Para asignar su propia flota, llamar assign_transporter con transporterCompanyId="own_fleet". No es necesario preguntar al usuario cual empresa.';
    }

    return this.storePendingSelection(session, items, {
      headerText: '👤 Transportistas disponibles.\nSeleccione uno:',
      listButtonLabel: 'Ver transportistas',
      sectionTitle: 'TRANSPORTISTAS',
    }, 'transporter_info', extraJson);
  }

  // ---- assign_transporter ----
  private async toolAssignTransporter(input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!companyType.includes('plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden asignar transportistas.' });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    // Resolve "own_fleet" shortcut to user's own company
    let transporterCompanyId = input.transporterCompanyId;
    const isOwnFleetShortcut = transporterCompanyId === OWN_FLEET_SHORTCUT;
    if (isOwnFleetShortcut) {
      transporterCompanyId = user.activeCompanyId || user.companyId;
    }

    const transporter = await this.prisma.company.findUnique({
      where: { id: transporterCompanyId },
      select: { name: true, hasInternalFleet: true },
    });
    if (!transporter) return JSON.stringify({ error: 'Empresa transportista no encontrada.' });
    const transporterName = transporter.name;

    // Persist own fleet decision if using own_fleet shortcut
    if (isOwnFleetShortcut && (freight as any).useOwnFleet == null) {
      await this.prisma.freight.update({ where: { id: freight.id }, data: { useOwnFleet: true } as any });
    }

    // Resolve the acting company: plant users only
    const actingCompanyId = this.resolvePlantCompanyId(user);

    const userCompanyId = user.activeCompanyId || user.companyId;
    const isOwnFleet = transporter.hasInternalFleet && transporterCompanyId === userCompanyId;
    const displayName = isOwnFleet ? `${transporterName} (Flota interna)` : transporterName;

    return this.stageAction(session, 'assign_transporter', {
      freightId: freight.id, code: freight.code,
      transporterCompanyId,
      transporterName: displayName,
      truckId: input.truckId || null,
      driverId: input.driverId || null,
      plantCompanyId: actingCompanyId,
    }, `Asignar transportista "${displayName}" a flete ${freight.code}`);
  }

  // ---- assign_truck_to_trip ----
  private async toolAssignTruckToTrip(input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!companyType.includes('plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden editar asignaciones.' });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { freightId: freight.id, status: { in: ['active', 'accepted'] } },
      select: { id: true },
    });
    if (!assignment) {
      return JSON.stringify({ error: `${input.code} no tiene asignación activa.` });
    }

    const truck = await this.prisma.truck.findUnique({
      where: { id: input.truckId },
      select: { plate: true, model: true },
    });
    const truckDisplay = truck ? (truck.model ? `${truck.plate} (${truck.model})` : truck.plate) : input.truckId;
    const plantCompanyId = this.resolvePlantCompanyId(user);

    return this.stageAction(session, 'assign_truck_to_trip', {
      freightId: freight.id, code: freight.code,
      assignmentId: assignment.id,
      truckId: input.truckId,
      driverId: input.driverId || null,
      truckDisplay,
      plantCompanyId,
    }, `Asignar camión ${truckDisplay} a flete ${freight.code}`);
  }

  // ---- assign_truck_to_freight (multi-truck) ----
  private async toolAssignTruckToFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const truckCount = freight.truckCount || 1;
    const assigned = freight.assignedTruckCount || 0;

    if (assigned >= truckCount) {
      return JSON.stringify({ error: `${freight.code} ya tiene todos los viajes asignados (${assigned}/${truckCount}).` });
    }

    // Resolve "own_fleet" shortcut
    let transporterCompanyId = input.transporterCompanyId;
    if (transporterCompanyId === OWN_FLEET_SHORTCUT) {
      transporterCompanyId = user.activeCompanyId || user.companyId;
    }

    const transporter = await this.prisma.company.findUnique({
      where: { id: transporterCompanyId },
      select: { name: true, hasInternalFleet: true },
    });
    if (!transporter) return JSON.stringify({ error: 'Empresa transportista no encontrada.' });

    const userCompanyId = user.activeCompanyId || user.companyId;
    const isOwnFleet = transporter.hasInternalFleet && transporterCompanyId === userCompanyId;
    const displayName = isOwnFleet ? `${transporter.name} (Flota interna)` : transporter.name;

    // Resolve plantCompanyId for the assignment call
    const companyType = this.resolveCompanyType(user);
    let plantCompanyId: string;
    if (companyType.includes('plant')) {
      plantCompanyId = this.resolvePlantCompanyId(user);
    } else {
      plantCompanyId = freight.destCompanyId || userCompanyId;
    }

    const nextTrip = assigned + 1;
    const remaining = truckCount - assigned - 1;

    return this.stageAction(session, 'assign_truck_to_freight', {
      freightId: freight.id, code: freight.code,
      transporterCompanyId,
      transporterName: displayName,
      truckId: input.truckId || null,
      driverId: input.driverId || null,
      tons: input.tons || null,
      plantCompanyId,
      nextTripNumber: nextTrip,
      remaining,
      truckCount,
      assignedTruckCount: assigned,
    }, `Asignar ${displayName} a viaje #${nextTrip} de ${freight.code} (quedan ${remaining} por asignar)`);
  }

  // ======================== TEAM MANAGEMENT TOOLS =========================

  // ---- list_company_users ----
  private async toolListCompanyUsers(user: any, session: any): Promise<string> {
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
      return JSON.stringify({ error: 'No se encontró tu empresa.', users: [] });
    }

    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId: { in: companyIds }, active: true },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, active: true } },
        company: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const ROLE_LABEL: Record<string, string> = { admin: 'Admin', operator: 'Operador', chofer: 'Chofer' };
    const activeUsers = memberships.filter(m => m.user.active);

    if (activeUsers.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay usuarios activos.' });
    }

    const items = activeUsers.map(m => ({
      id: `user:${m.user.id}`,
      title: (m.user.name || 'Sin nombre').slice(0, 24),
      description: `${ROLE_LABEL[m.role] || m.role} · ${m.company.name}`.slice(0, 72),
    }));

    const usersData = activeUsers.map(m => ({
      id: m.user.id, name: m.user.name, email: m.user.email,
      phone: m.user.phone, role: m.role, company: m.company.name,
    }));

    return this.storePendingSelection(session, items, {
      headerText: '👤 Usuarios de la empresa.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver usuarios',
      sectionTitle: 'USUARIOS',
    }, 'user_info', { users: usersData });
  }

  // ---- list_drivers ----
  private async toolListDrivers(user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const drivers = await this.trucksService.listDrivers(synUser);

    if ((drivers as any[]).length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay choferes registrados.' });
    }

    const driverIds = (drivers as any[]).map(d => d.id);
    const trucks = await this.prisma.truck.findMany({
      where: { assignedUserId: { in: driverIds }, active: true },
      select: { assignedUserId: true, plate: true, model: true },
    });
    const truckByDriver = new Map(trucks.map(t => [t.assignedUserId, t]));

    const items = (drivers as any[]).map((d: any) => {
      const truck = truckByDriver.get(d.id);
      const truckLabel = truck ? (truck.model ? `${truck.plate} (${truck.model})` : truck.plate) : 'Sin camión';
      return {
        id: `driver:${d.id}`,
        title: (d.name || 'Sin nombre').slice(0, 24),
        description: truckLabel.slice(0, 72),
      };
    });

    const driversData = (drivers as any[]).map((d: any) => {
      const truck = truckByDriver.get(d.id);
      return {
        id: d.id, name: d.name, phone: d.phone,
        assignedTruck: truck ? (truck.model ? `${truck.plate} (${truck.model})` : truck.plate) : null,
      };
    });

    return this.storePendingSelection(session, items, {
      headerText: '👤 Choferes registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver choferes',
      sectionTitle: 'CHOFERES',
    }, 'driver_info', { drivers: driversData });
  }

  // ======================== ACCESS MANAGEMENT TOOLS ========================

  // ---- update_user_role ----
  private async toolUpdateUserRole(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden cambiar roles.' });
    }
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
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
      return JSON.stringify({ error: `No se encontró un usuario "${searchTerm}" en su empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No puede cambiar su propio rol.' });
    }

    return this.stageAction(session, 'update_user_role', {
      membershipId: membership.id,
      companyId: membership.companyId,
      targetUserId: membership.user.id,
      userName: membership.user.name,
      newRole: input.newRole,
    }, `Cambiar rol de "${membership.user.name}" a ${input.newRole}`);
  }

  // ---- deactivate_user ----
  private async toolDeactivateUser(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden desactivar usuarios.' });
    }
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
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
      return JSON.stringify({ error: `No se encontró un usuario activo "${searchTerm}" en su empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No puede desactivarse a sí mismo.' });
    }

    return this.stageAction(session, 'deactivate_user', {
      membershipId: membership.id,
      targetUserId: membership.user.id,
      userName: membership.user.name,
    }, `Desactivar usuario "${membership.user.name}" de su empresa`);
  }

  // ---- switch_company ----
  private async toolSwitchCompany(input: any, user: any, session: any): Promise<string> {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    if (memberships.length <= 1) {
      return JSON.stringify({ error: 'Solo pertenece a una empresa. No es posible cambiar.' });
    }

    const TYPE_LABELS: Record<string, string> = {
      producer: 'Productor', plant: 'Planta', transporter: 'Transportista',
    };

    // If no companyId, send interactive selection to user
    if (!input.companyId) {
      const activeCompanyId = user.activeCompanyId || user.companyId;
      const companies = memberships.map((m: any) => ({
        id: m.companyId,
        name: m.company?.name || 'Empresa',
        type: TYPE_LABELS[m.company?.type] || m.company?.type || 'Desconocido',
        active: m.companyId === activeCompanyId,
      }));

      // Store pending selection for the router to send as interactive list
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const currentState = (freshSession?.flowState as any) || {};
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          flowState: {
            ...currentState,
            _pendingSelection: {
              items: companies.map(c => ({
                id: `selco:${c.id}`,
                title: c.name,
                description: `${c.type}${c.active ? ' (actual)' : ''}`,
              })),
              config: {
                headerText: 'Seleccione la empresa con la que desea operar:',
                listButtonLabel: 'Ver empresas',
                sectionTitle: 'Sus empresas',
              },
              purpose: 'company_selection',
            },
          },
        },
      });

      return JSON.stringify({
        companies,
        message: 'Se presenta la lista de empresas al usuario. Espere a que seleccione una.',
        _selectionSent: true,
      });
    }

    // Validate membership
    const target = memberships.find((m: any) => m.companyId === input.companyId);
    if (!target) {
      return JSON.stringify({ error: 'No pertenece a esa empresa.' });
    }

    // Perform the switch in DB
    const oldCompanyId = user.activeCompanyId || user.companyId;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { activeCompanyId: input.companyId, companyId: input.companyId },
    });

    // Invalidate web sessions: refresh tokens carry old companyId
    this.prisma.refreshToken.deleteMany({ where: { userId: user.id } })
      .catch((err: any) => this.logger.warn(`Failed to inválidate refresh tokens: ${err.message}`));

    // Audit log (fire-and-forget)
    this.prisma.auditLog.create({
      data: {
        entityType: 'user', entityId: user.id,
        action: 'switch_company',
        fromValue: oldCompanyId || undefined,
        toValue: input.companyId, userId: user.id,
        metadata: { source: 'whatsapp_ai' },
      },
    }).catch((err: any) => this.logger.warn(`Audit log failed: ${err.message}`));

    // Update session: mark confirmed + clear AI history for clean context
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          companyConfirmed: true,
          selectedCompanyId: input.companyId,
          aiMessages: [],
        },
      },
    });

    const companyName = target.company?.name || 'Empresa';
    const companyType = TYPE_LABELS[target.company?.type] || target.company?.type || '';

    return JSON.stringify({
      status: 'switched',
      companyName,
      companyType,
      message: `Empresa activa cambiada a "${companyName}" (${companyType}). Todas las operaciones se realizarán con esta empresa.`,
    });
  }

  // ======================== MESSAGE PREPROCESSING ========================

  /** Clean audio transcription: strip filler words, normalize whitespace, expand spelled-out letters */
  private preprocessMessage(text: string): string {
    let clean = text
      .replace(AUDIO_FILLERS, ' ')       // Strip filler words from voice
      .replace(/\bv\s+corta\b/gi, 'v')  // Whisper spells out "v corta" → v
      .replace(/\bb\s+larga\b/gi, 'b')  // Whisper spells out "b larga" → b
      .replace(/\bese\s+de\b/gi, 's')   // "ese de" → s
      .replace(/\bdoble\s+ele\b/gi, 'll') // "doble ele" → ll
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
    //    Exception: freight lists (contain freight codes) are allowed to be longer
    if (clean.length > MAX_RESPONSE_CHARS && !/F\d{2}-[A-Z]{3}\.\d{4}|FLT-\d{4,}/i.test(clean)) {
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

  // ======================== GENERIC CONFIRMATION ========================

  /** Stage an action for user confirmation — stores pendingAction + buttons in session */
  private async stageAction(
    session: any,
    tool: string,
    params: Record<string, any>,
    summary: string,
  ): Promise<string> {
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const state = (freshSession?.flowState as any) || {};

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          pendingAction: { tool, params, summary },
          _pendingButtons: [
            { id: 'ai_confirm', title: 'CONFIRMAR' },
            { id: 'ai_cancel', title: 'CANCELAR' },
          ],
        },
      },
    });

    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      IMPORTANT: 'La acción NO fue ejecutada todavía. Presente el resumen y consulte al usuario si confirma. Se enviaran botones CONFIRMAR/CANCELAR automáticamente.',
    });
  }

  // ======================== NEW TOOLS: FEATURE PARITY ===================

  // ---- authorize_freight ----
  private async toolAuthorizeFreight(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    if (freight.status !== 'assigned') return JSON.stringify({ error: `Solo se puede autorizar en estado "assigned". Estado actual: "${freight.status}".` });
    if (!freight.useOwnFleet) return JSON.stringify({ error: 'Solo se puede autorizar fletes con flota propia.' });
    return this.stageAction(session, 'authorize_freight', { freightId: freight.id, code: freight.code }, `Autorizar flete ${freight.code} (flota propia)`);
  }

  // ---- approve_pending_change ----
  private async toolApprovePendingChange(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    const userCompanyId = user.activeCompanyId || user.companyId;

    const pendingChanges = await this.prisma.freightPendingChange.findMany({
      where: { freightId: freight.id, status: 'pending' },
      include: { requestedBy: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (pendingChanges.length === 0) return JSON.stringify({ error: `El flete ${freight.code} no tiene cambios pendientes de aprobación.` });

    let change: any;
    if (input.changeId) {
      change = pendingChanges.find((c: any) => c.id === input.changeId);
      if (!change) return JSON.stringify({ error: `No se encontró el cambio pendiente ${input.changeId}.` });
    } else if (pendingChanges.length === 1) {
      change = pendingChanges[0];
    } else {
      const list = pendingChanges.map((c: any) => `- ${c.id}: ${c.changeType} (solicitado por ${c.requestedBy?.name || 'desconocido'})`).join('\n');
      return JSON.stringify({ error: `El flete tiene ${pendingChanges.length} cambios pendientes. Indique el changeId:\n${list}` });
    }

    if (change.approverCompanyId !== userCompanyId) {
      return JSON.stringify({ error: 'Su empresa no es la aprobadora de este cambio.' });
    }

    const summary = `Aprobar cambio "${change.changeType}" en flete ${freight.code} (solicitado por ${change.requestedBy?.name || 'desconocido'})`;
    return this.stageAction(session, 'approve_pending_change', { freightId: freight.id, changeId: change.id, code: freight.code }, summary);
  }

  // ---- reject_pending_change ----
  private async toolRejectPendingChange(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    const userCompanyId = user.activeCompanyId || user.companyId;

    const pendingChanges = await this.prisma.freightPendingChange.findMany({
      where: { freightId: freight.id, status: 'pending' },
      include: { requestedBy: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (pendingChanges.length === 0) return JSON.stringify({ error: `El flete ${freight.code} no tiene cambios pendientes.` });

    let change: any;
    if (input.changeId) {
      change = pendingChanges.find((c: any) => c.id === input.changeId);
      if (!change) return JSON.stringify({ error: `No se encontró el cambio pendiente ${input.changeId}.` });
    } else if (pendingChanges.length === 1) {
      change = pendingChanges[0];
    } else {
      const list = pendingChanges.map((c: any) => `- ${c.id}: ${c.changeType} (solicitado por ${c.requestedBy?.name || 'desconocido'})`).join('\n');
      return JSON.stringify({ error: `El flete tiene ${pendingChanges.length} cambios pendientes. Indique el changeId:\n${list}` });
    }

    if (change.approverCompanyId !== userCompanyId) {
      return JSON.stringify({ error: 'Su empresa no es la aprobadora de este cambio.' });
    }

    const summary = `Rechazar cambio "${change.changeType}" en flete ${freight.code}${input.reason ? ` — Motivo: ${input.reason}` : ''}`;
    return this.stageAction(session, 'reject_pending_change', { freightId: freight.id, changeId: change.id, code: freight.code, reason: input.reason }, summary);
  }

  // ---- resolveAssignment helper ----
  private async resolveAssignment(code: string, assignmentId: string | undefined, user: any): Promise<{ freight?: any; assignment?: any; error?: string }> {
    const result = await this.resolveFreightWithAccess(code, user);
    if (result.error) return { error: result.error };
    const freight = result.freight;
    if (!freight.assignments || freight.assignments.length === 0) return { error: `El flete ${code} no tiene asignaciones activas.` };
    if (assignmentId) {
      const a = freight.assignments.find((a: any) => a.id === assignmentId);
      if (!a) return { error: `No se encontró la asignación ${assignmentId} en el flete ${code}.` };
      return { freight, assignment: a };
    }
    if (freight.assignments.length === 1) return { freight, assignment: freight.assignments[0] };
    const list = freight.assignments.map((a: any) => `- ${a.id}: ${a.truck?.plate || 'sin camión'} (${a.driver?.name || 'sin chofer'}) — ${a.tripStatus || 'sin estado'}`).join('\n');
    return { error: `El flete ${code} tiene ${freight.assignments.length} viajes. Indique el assignmentId. Viajes:\n${list}` };
  }

  // ---- respond_trip ----
  private async toolRespondTrip(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'pending') {
      return JSON.stringify({ error: `El viaje ya está en estado "${assignment.tripStatus}". Solo se puede aceptar/rechazar en "pending".` });
    }
    if (input.action === 'rejected' && !input.reason) {
      return JSON.stringify({ error: 'Para rechazar un viaje debe indicar un motivo (reason).' });
    }
    const label = input.action === 'accepted' ? 'Aceptar' : 'Rechazar';
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    const summary = `${label} viaje de ${freight.code} (${tripInfo})${input.action === 'rejected' ? ` — Motivo: ${input.reason}` : ''}`;
    return this.stageAction(session, 'respond_trip', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code,
      action: input.action, reason: input.reason, tripInfo,
    }, summary);
  }

  // ---- start_trip ----
  private async toolStartTrip(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'accepted') {
      return JSON.stringify({ error: `El viaje debe estar "accepted" para iniciarlo. Estado actual: "${assignment.tripStatus}".` });
    }
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'start_trip', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, tripInfo,
    }, `Iniciar viaje de ${freight.code} (${tripInfo})`);
  }

  // ---- confirm_trip_loaded ----
  private async toolConfirmTripLoaded(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'in_progress') {
      return JSON.stringify({ error: `El viaje debe estar "in_progress" para confirmar carga. Estado actual: "${assignment.tripStatus}".` });
    }
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    const tonsNote = input.loadedTons ? ` — ${input.loadedTons} toneladas` : '';
    return this.stageAction(session, 'confirm_trip_loaded', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, tripInfo, loadedTons: input.loadedTons,
    }, `Confirmar carga de viaje ${freight.code} (${tripInfo})${tonsNote}`);
  }

  // ---- confirm_trip_finished ----
  private async toolConfirmTripFinished(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'loaded') {
      return JSON.stringify({ error: `El viaje debe estar "loaded" para confirmar entrega. Estado actual: "${assignment.tripStatus}".` });
    }
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'confirm_trip_finished', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, tripInfo,
    }, `Confirmar entrega de viaje ${freight.code} (${tripInfo})`);
  }

  // ---- cancel_assignment ----
  private async toolCancelAssignment(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'cancel_assignment', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, reason: input.reason, tripInfo,
    }, `Cancelar asignación de ${freight.code} (${tripInfo}) — Motivo: ${input.reason}`);
  }

  // ---- update_assignment ----
  private async toolUpdateAssignment(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (!['pending', 'accepted'].includes(assignment.tripStatus || '')) {
      return JSON.stringify({ error: `Solo se pueden editar viajes en estado "pending" o "accepted". Estado actual: "${assignment.tripStatus}".` });
    }
    const changes: string[] = [];
    const dto: any = {};
    if (input.transporterCompanyId) { dto.transportCompanyId = input.transporterCompanyId; changes.push('transportista'); }
    if (input.truckId) { dto.truckId = input.truckId; changes.push('camión'); }
    if (input.driverId) { dto.driverId = input.driverId; changes.push('chofer'); }
    if (input.tons !== undefined) { dto.tons = input.tons; changes.push(`toneladas: ${input.tons}`); }
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios. Indique al menos uno: transporterCompanyId, truckId, driverId o tons.' });
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'update_assignment', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, dto, tripInfo,
      plantCompanyId: this.resolvePlantCompanyId(user),
    }, `Editar viaje de ${freight.code} (${tripInfo}): ${changes.join(', ')}`);
  }

  // ---- create_driver ----
  private async toolCreateDriver(input: any, user: any, session: any): Promise<string> {
    if (!input.name?.trim()) return JSON.stringify({ error: 'El nombre del chofer es obligatorio.' });
    const summary = `Registrar chofer: ${input.name}${input.phone ? ` (${input.phone})` : ''}`;
    return this.stageAction(session, 'create_driver', {
      name: input.name.trim(), phone: input.phone?.trim(), companyId: user.activeCompanyId || user.companyId,
    }, summary);
  }

  // ---- update_profile ----
  private async toolUpdateProfile(input: any, user: any, session: any): Promise<string> {
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (input.email) changes.push(`email: ${input.email}`);
    if (input.phone) changes.push(`teléfono: ${input.phone}`);
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios. Indique al menos uno: name, email o phone.' });
    return this.stageAction(session, 'update_profile', {
      userId: user.id, name: input.name, email: input.email, phone: input.phone,
    }, `Editar perfil: ${changes.join(', ')}`);
  }

  // ---- generate_batch_report_link ----
  private async toolGenerateBatchReportLink(input: any, _user: any): Promise<string> {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.dateFrom) params.set('from', input.dateFrom);
    if (input.dateTo) params.set('to', input.dateTo);
    const qs = params.toString();
    const url = `${APP_URL}/reports${qs ? `?${qs}` : ''}`;
    return JSON.stringify({ url, message: `Enlace a reportes: ${url}\nDesde ahí puede descargar PDF o Excel con los filtros aplicados.` });
  }

  // ======================== HELPERS =====================================

  /** Resolve freight by code WITH access control — returns { freight } or { error } */
  private async resolveFreightWithAccess(code: string, user: any): Promise<{ freight?: any; error?: string }> {
    const freight = await this.prisma.freight.findFirst({
      where: { code: code.toUpperCase() },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
    });
    if (!freight) return { error: `No se encontró ${code}` };

    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [
      freight.originCompanyId, freight.destCompanyId,
      ...freight.assignments.map((a: any) => a.transportCompanyId),
    ].filter(Boolean);
    const isDriver = freight.assignments.some((a: any) => a.driverId === user.id);
    const isCompanyUser = allUserCompanies.some((c: string) => freightCompanies.includes(c));
    if (!isDriver && !isCompanyUser) {
      return { error: `No tiene acceso al flete ${code}` };
    }
    // Drivers without company access only see their own assignment
    if (isDriver && !isCompanyUser) {
      freight.assignments = freight.assignments.filter((a: any) => a.driverId === user.id);
    }
    return { freight };
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

  /** Check if caller is admin/gerente — scoped to specific company when provided */
  private isCallerAdminForCompany(user: any, companyId?: string): boolean {
    if (user.isSuperAdmin || user.role === 'platform_admin') return true;
    if (!companyId) {
      // Fallback: check any membership
      const memberRoles = (user.memberships || []).map((m: any) => m.role);
      return [user.role || '', ...memberRoles].some((r: string) => ['admin', 'gerente', 'platform_admin'].includes(r));
    }
    // Scoped: check membership for the specific company
    const membership = (user.memberships || []).find((m: any) => m.companyId === companyId && m.active);
    if (!membership) return false;
    return ['admin', 'gerente'].includes(membership.role);
  }

  private buildSyntheticUser(dbUser: any): any {
    return buildSyntheticUser(dbUser);
  }
}

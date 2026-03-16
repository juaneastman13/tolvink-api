# Tolvink AI Agent — Complete Behavior Snapshot

Generated: 2026-03-16

---

## 1. System Prompt

File: `src/ai/prompt/prompt-builder.service.ts`

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  URUGUAY_UTC_OFFSET_MS, FREIGHT_STATUS_SHORT, APP_URL,
} from '../ai.constants';
import {
  resolveActiveRole, resolveCompanyTypes, hasType, sanitizeForPrompt, isProducerMembership,
} from '../ai.utils';

@Injectable()
export class PromptBuilderService {
  private readonly logger = new Logger(PromptBuilderService.name);

  constructor(private prisma: PrismaService) {}

  /** Resolve producer company ID for the user (active company priority, then first producer membership). */
  private resolveProducerCompanyId(user: any): string | null {
    if (user.memberships?.length > 0) {
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isProducerMembership(m));
        if (activeMem) return activeMem.companyId;
      }
      const pm = user.memberships.find(isProducerMembership);
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('producer') && companyByType.producer) return companyByType.producer;
    if (resolveCompanyTypes(user.company).includes('producer')) return user.companyId;
    return null;
  }

  async build(user: any, companyType: string, isWeb = false): Promise<string> {
    const name = sanitizeForPrompt(user.name?.split(' ')[0] || 'usuario');
    const nowUY = new Date(Date.now() + URUGUAY_UTC_OFFSET_MS);
    const today = nowUY.toISOString().split('T')[0];

    const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = activeMemberships.find((m: any) => m.companyId === activeCoId);
    const activeCoName = sanitizeForPrompt(activeMem?.company?.name || user.company?.name || '');

    const hasOwnFleet = activeMem?.company?.hasInternalFleet ||
      (!activeMem && user.company?.hasInternalFleet);
    const ownFleetNote = hasOwnFleet
      ? `\nFLOTA INTERNA: Tiene flota propia. Preguntar siempre: "¿Desea usar su flota propia o que la planta asigne?" Si sí → assign_transporter con transporterCompanyId="own_fleet".`
      : '';
    const multiCompanyNote = activeMemberships.length > 1
      ? `\nEMPRESA ACTIVA: ${activeCoName} (${companyType}). Pertenece a ${activeMemberships.length} empresas. Usar switch_company SOLO si el usuario pide cambiar. NO pedir que seleccione empresa si ya está operando correctamente.`
      : '';

    const { isChofer, isAdmin, userRole } = resolveActiveRole(user);

    const roleParts: string[] = [];
    if (isChofer) {
      roleParts.push(`ROL: Chofer
PUEDE: ver sus fletes asignados, aceptar/rechazar asignaciones, iniciar viaje, confirmar carga, confirmar entrega, consultar estado, compartir ubicación, adjuntar documentos.
NO PUEDE: crear fletes, cancelar fletes, asignar transportistas, gestionar campos/lotes/camiones/usuarios, ver dashboard de empresa.
ATAJOS: "mis fletes" → list_freights(status="accepted"). "ya cargué" → confirm_loaded. "ya llegué" → confirm_finished. "salí" → start_freight.
MULTI-CAMIÓN: Usar respond_trip, start_trip, confirm_trip_loaded, confirm_trip_finished para viajes individuales.
PROACTIVO: Si escribe sin contexto, mostrar sus fletes asignados/activos con list_freights ANTES de pedir código.`);
    } else {
      if (hasType(companyType, 'producer')) {
        roleParts.push(`ROL: Productor (${userRole})
PUEDE: crear fletes (desde sus campos hacia plantas habilitadas), ver/cancelar sus fletes, gestionar campos/lotes, confirmar carga, ver dashboard, adjuntar documentos.
NO PUEDE: asignar transportistas a fletes ajenos, autorizar fletes, gestionar accesos de productores, confirmar entrega en planta.
ATAJOS: "mandar soja" → crear flete. "mis fletes" → get_dashboard. "mis campos" → list_fields.`);
      }
      if (hasType(companyType, 'plant')) {
        roleParts.push(`ROL: Planta (${userRole})
PUEDE: ver fletes dirigidos a su planta, asignar transportistas, autorizar fletes con flota propia, confirmar entrega/recepción, gestionar accesos de productores, gestionar sucursales.
NO PUEDE: crear fletes, gestionar campos/lotes de productores.
ATAJOS: "pendientes" → list_freights(status="pending_assignment"). "asignar" → list_freights + assign_transporter. "autorizar" → authorize_freight.`);
      }
      if (hasType(companyType, 'transporter')) {
        roleParts.push(`ROL: Transportista (${userRole})
PUEDE: ver fletes asignados, aceptar/rechazar, gestionar camiones y choferes, confirmar carga/entrega.
NO PUEDE: crear fletes, cancelar fletes ajenos, gestionar campos/lotes.
ATAJOS: "asignados" → list_freights(status="assigned"). "mis camiones" → list_trucks. "mis choferes" → list_drivers.`);
      }
      if (roleParts.length === 0) {
        roleParts.push(`ROL: Operario (${userRole})
PUEDE: consultar fletes y dashboard.
NO PUEDE: crear, modificar ni cancelar fletes. No puede gestionar recursos.`);
      }
    }

    const roleBlock = roleParts.join('\n');

    let basePrompt = `Sos Tolvink, asistente de logística agrícola para gestión de fletes de granos en Uruguay.
USUARIO: ${name} | Empresa: ${activeCoName} (${companyType}) | Fecha: ${today} | Uruguay (UTC-3)
${roleBlock}${ownFleetNote}${multiCompanyNote}

TONO Y FORMATO:
- Hablás español rioplatense: tuteo natural, vocabulario del campo. Profesional pero cercano.
- Mensajes cortos — esto es WhatsApp, no un email. Máximo 3-4 líneas salvo resúmenes.
- Sin disclaimers, sin tecnicismos.${isWeb ? '' : ' Sin *negritas* ni markdown.'}
- No mencionar nombres de herramientas ni estados internos (in_progress, pending_assignment, etc.) — traducir siempre.
- No repetir información ya dada. No saludar si ya lo hiciste.
- Emojis solo como bullets al inicio de línea: 🌾📦🚛📍📅🕒👤🏢✅⚠️❌⏳

ESTADOS DEL FLETE (traducir SIEMPRE):
Borrador | Pendiente de asignación | Asignado | Aceptado | En camino | Cargado | Entregado | Cancelado

GRANOS: Soja, Maíz, Trigo, Girasol, Sorgo, Cebada, Otros.

BÚSQUEDA PROACTIVA:
- NUNCA pedir código de flete si podés buscar. Código directo → get_freight_detail. Sin código → list_freights con filtros.
- Consultas vagas ("cómo va todo", "novedades") → get_dashboard.
- "el flete de soja" → list_freights(grain="Soja"). "quiero rechazar" → list_freights(status="assigned").
- Pedir código solo si hay ambigüedad DESPUÉS de buscar.

CONTEXTO:
- Mantener hilo. Resolver "eso", "el flete", "ese campo" del historial.
- FLETE ACTIVO: al consultar un flete queda activo para acciones. No re-pedir código.
- Se pierde al: seleccionar otro flete, cambiar empresa, expirar sesión.
- Fechas en UTC-3. "a las 8" = 08:00. Formatos: "15/3", "mañana", "el lunes".
- Si se recuperó contexto de sesión expirada, mencionar: "Veo que estabas con un flete a [destino]. ¿Seguimos con eso?"

DATOS PRE-CARGADOS:
- Si el usuario tiene UN solo campo/planta/camión, usarlo sin preguntar. Mencionar cuál usaste.
- Si tiene MÚLTIPLES, mostrar lista interactiva para elegir.
- Referenciar fletes recientes cuando sea relevante ("Tenés un flete pendiente a Planta X, ¿consultamos ese?").
- NUNCA preguntar datos que ya tenés en el contexto.

ANTI-ALUCINACIÓN:
- SOLO afirmar datos de resultados de herramientas. NUNCA inventar códigos, nombres, toneladas, fechas.
- NUNCA confirmar una acción que la herramienta no ejecutó.
- NUNCA exponer UUIDs. Solo códigos completos (ej: F26-LCP.1822).

CONFIRMACIÓN (2 etapas):
Toda acción que modifica datos: herramienta PREPARA → mostrás resumen → usuario confirma → confirm_action (o confirm_create_freight para fletes nuevos). Sin confirm NO se ejecutó. Botones se envían automáticamente.

CREAR FLETE — ONE-SHOT:
Cuando el usuario da múltiples datos en un mensaje, extraer TODOS sin preguntar lo que ya dijo.
Ej: "mandá 30 de soja de cerros negros maizales a sofoval miguelete mañana" → extraer grano, tons, campo, lote, planta, sucursal, fecha. Resolver cada entidad con fuzzy search. Si TODO se resuelve → ir DIRECTO a prepare_freight → resumen.

Datos necesarios:
1. ORIGEN: campo + lote. Si tiene 1 campo → usarlo sin preguntar. Si el campo tiene 1 lote → auto-seleccionar.
2. DESTINO: planta + sucursal. Si la planta tiene 1 sucursal → auto-seleccionar. Si tiene varias → preguntar cuál.
3. GRANO y TONELADAS.
4. FECHA y HORA (YYYY-MM-DD, HH:mm). "mañana"/"el lunes"/"pasado" → resolver a fecha exacta.
5. CAMIONES: calcular auto 1 cada 30t (redondear arriba). 13t=1, 45t=2, 90t=3. Informar cálculo.
6. TRANSPORTE: ¿flota propia o delegado? Solo preguntar si aplica.
7. CONFIRMACIÓN: prepare_freight → resumen → confirm_create_freight.

REGLAS CRÍTICAS:
- NUNCA re-preguntar un dato ya proporcionado. "1 camión que asigne Sofoval" = truckCount=1 + delegado.
- Respuestas compuestas: extraer TODOS los datos del mensaje y preguntar solo lo faltante.
- Auto-resolver nombres con fuzzy search. NO buscar IDs manualmente.
- Duplicar flete: "repetí el último" / "lo mismo" / "igual que antes" → buscar último flete con list_freights, duplicar con fecha hoy. Solo pedir fecha nueva si no la dijo.
- "al mismo lugar" / "a la misma planta" → reusar destino del último flete.
- Origen/destino custom sin coordenadas → generate_location_link.

DEFAULTS INTELIGENTES:
- Si creó un flete en las últimas 24h → ofrecer misma planta: "¿Va a Sofoval Miguelete como el anterior?"
- SIEMPRE informar qué auto-seleccionaste para que pueda corregir.

CORRECCIONES EN LÍNEA:
Si el usuario corrige un dato durante la creación ("no, son 40 toneladas", "perdón, de trigo", "cambiá el destino a Young"):
- Actualizar ESE dato y mantener todos los demás.
- Mostrar resumen actualizado completo.
- Palabras clave: "no,", "perdón", "cambiá", "en realidad", "corrijo", "quise decir", "mejor".
- NUNCA reiniciar el flujo por una corrección.

ASIGNAR TRANSPORTISTA:
- Flota propia → assign_transporter(transporterCompanyId="own_fleet").
- Externa → list_transporters → selección → assign_transporter → confirm_action.
- Multi-camión → assign_truck_to_freight por viaje adicional.
- Carga/entrega requieren confirmación de AMBAS partes.

GESTIÓN CAMIONES EN FLETES:
- Agregar: update_freight(truckCount=nuevo) + assign_truck_to_freight si flota propia.
- Quitar con camión asignado: cancel_assignment + update_freight(truckCount=nuevo).
- Quitar sin camión: solo update_freight(truckCount=nuevo).

LISTAS Y SELECCIÓN:
- _selectionSent:true → lista YA enviada. NO repetir ítems. Solo frase contextual breve.
- Toda selección DEBE ser menú interactivo (list_fields, list_lots, list_trucks, etc.). NUNCA opciones como texto plano.
- Resúmenes → summarize_freights. Selección individual → list_freights.

RESOLUCIÓN DE ENTIDADES:
- Usar fuzzy search para nombres de plantas, campos, sucursales.
- Match único con score alto → usar sin preguntar.
- Múltiples matches → Reply Buttons (2-3 opciones) o List Message (4+).
- Sin match → decirlo y sugerir opciones cercanas.

AMBIGÜEDAD: Si el mensaje no es claro, hacer UNA pregunta clarificadora. Preferir Reply Buttons para sí/no y opciones cortas.

LENGUAJE ORAL Y COLOQUIAL:
Los usuarios envían audios transcritos. Interpretar con tolerancia:
- "dale"/"sí dale"/"va"/"metele"/"manda" = confirmación. "no"/"dejá"/"pará"/"olvidate"/"cancelá" = cancelación.
- "lo mismo"/"igual que antes"/"al mismo lugar"/"como el último" = duplicar último flete.
- "treinta"/"cuarenta y cinco" = números escritos. "mañana"/"pasado"/"el lunes" = fechas relativas.
- "pa sofoval"/"pal miguelete" = destinos con preposición informal.
- Transcripciones con errores: "cerro negro"="cerros negros", "solla"=Soja, "tigo"=Trigo.
- NUNCA pedir que "reformule". Si hay ambigüedad, preguntar con opciones concretas.

RESPUESTAS CONTEXTUALES:
Cuando hay pregunta pendiente, interpretar respuestas cortas en contexto:
- Si preguntaste "¿Aceptás?" y dice "dale" → ACEPTAR. No preguntar "¿estás seguro?"
- Si preguntaste "¿Cuántos camiones?" y dice "2" → truckCount=2.
- Si preguntaste "¿Flota propia o delegado?" y dice "propia" → useOwnFleet=true.
- NUNCA pedir confirmación de una confirmación. Excepción: cancelar flete SÍ requiere doble confirmación.

DOCUMENTOS: Archivo pendiente + flete activo → attach_document directo. Foto de remito/pesaje → ocr_analyze.

UBICACIONES:
- No mostrar coordenadas crudas.${isAdmin ? ' Admins pueden pedir coordenadas.' : ''}
- Con mapLink → frase + link. Sin mapLink → "Ubicación no disponible."
- Marcar ubicación → generate_location_link.

ERRORES: No mostrar errores técnicos. "Hubo un problema, ¿podés intentar de nuevo?" Si no soporta la acción, decirlo claro.

LINKS:
- Web: ${APP_URL}
- Detalle de flete: usar campo "link" de get_freight_detail.
- Mapa del día: generate_daily_map_link.
- PDF: generate_report_link.${isWeb ? `

NAVEGACIÓN (web):
- navigate_app lleva al usuario a pantallas: home, list, new, detail, calendar, reports, fields, trucks, menu, chats.
- Usarlo ADEMÁS de la respuesta informativa cuando tiene sentido visual.` : ''}`;

    // P1 fix: append proactive data summary so AI can reference without extra tool calls
    const proactiveLines: string[] = [];
    try {
      if (activeCoId) {
        if (hasType(companyType, 'producer')) {
          const producerCoId = this.resolveProducerCompanyId(user);
          if (producerCoId) {
            const [fields, lotCount] = await Promise.all([
              this.prisma.field.findMany({ where: { companyId: producerCoId, active: true }, select: { id: true, name: true, lots: { where: { active: true }, select: { name: true }, take: 10 } }, take: 10 }),
              this.prisma.lot.count({ where: { companyId: producerCoId, active: true } }),
            ]);
            const fieldCount = fields.length;
            proactiveLines.push(`Campos: ${fieldCount} | Lotes: ${lotCount}`);
            if (fieldCount === 1) {
              const f = fields[0];
              const lotNames = f.lots.map((l: any) => l.name).join(', ');
              proactiveLines.push(`Campo único: ${f.name}${lotNames ? ` (lotes: ${lotNames})` : ' (sin lotes)'}`);
            }

            const accesses = await this.prisma.plantProducerAccess.findMany({
              where: { producerCompanyId: producerCoId, active: true },
              select: { plantCompany: { select: { name: true } } },
              take: 10,
            });
            if (accesses.length > 0) {
              const plantNames = accesses.map(a => a.plantCompany?.name).filter(Boolean).slice(0, 5);
              proactiveLines.push(`Plantas habilitadas: ${plantNames.join(', ')}${accesses.length > 5 ? ` (+${accesses.length - 5} más)` : ''}`);
            }
          }
        }

        const recentFreights = await this.prisma.freight.findMany({
          where: { participantCompanyIds: { has: activeCoId }, status: { notIn: ['canceled', 'draft'] } },
          select: { code: true, status: true, destName: true, originName: true, items: { select: { grain: true, tons: true }, take: 1 }, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        });
        if (recentFreights.length > 0) {
          const fList = recentFreights.map(f =>
            `${f.code} (${FREIGHT_STATUS_SHORT[f.status] || f.status}, ${f.items[0]?.grain || '-'})`
          ).join(', ');
          proactiveLines.push(`Últimos fletes: ${fList}`);
          // Include last freight details for "same as last" defaults
          const last = recentFreights[0];
          const hoursAgo = (Date.now() - new Date(last.createdAt).getTime()) / 3600000;
          if (hoursAgo < 24) {
            proactiveLines.push(`Último flete (hace ${Math.round(hoursAgo)}h): ${last.items[0]?.grain || '-'} ${last.items[0]?.tons || '-'}t, ${last.originName} → ${last.destName}`);
          }
        }

        if (hasOwnFleet) {
          const [truckCount, driverCount] = await Promise.all([
            this.prisma.truck.count({ where: { companyId: activeCoId, active: true } }),
            this.prisma.userCompany.count({ where: { companyId: activeCoId, active: true, role: 'chofer' } }),
          ]);
          proactiveLines.push(`Flota propia: ${truckCount} camión(es), ${driverCount} chofer(es)`);
        }
      }
    } catch (e) {
      this.logger.warn(`Proactive data loading failed: ${e.message}`);
    }

    if (proactiveLines.length > 0) {
      basePrompt += `\n\nDATOS DEL USUARIO (pre-cargados, NO repetir al usuario salvo que pregunte):
${proactiveLines.join('\n')}
AUTO-SELECCIÓN: Si hay una sola opción (1 campo, 1 lote, 1 planta, 1 camión), seleccionarla automáticamente sin preguntar.`;
    }

    return basePrompt;
  }
}
```

---

## 2. Tool Definitions (62 tools)

File: `src/ai/ai-tool-definitions.ts`

### Freight Queries

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `list_freights` | Lista fletes del usuario como menú interactivo de WhatsApp | `status` (string, enum), `dateFrom` (string), `dateTo` (string), `grain` (string) | [] |
| `get_freight_detail` | Detalle completo de un flete por código | `code` (string) | [code] |
| `summarize_freights` | Resumen analítico de fletes con datos completos | `status` (string, enum), `groupBy` (string, enum), `dateFrom` (string), `dateTo` (string), `grain` (string), `transporterName` (string) | [] |
| `get_dashboard` | Resumen ejecutivo de la empresa | — | [] |
| `freight_history` | Historial completo de un flete | `code` (string) | [code] |

### Freight Creation

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `prepare_freight` | Prepara un flete para creación (NO lo crea) | `grain` (string, enum), `tons` (number), `truckCount` (number), `loadDate` (string), `loadTime` (string), `useOwnFleet` (boolean), `destPlantId` (string), `destName` (string), `branchId` (string), `customDestLat` (number), `customDestLng` (number), `originLotId` (string), `originName` (string), `customOriginName` (string), `customOriginLat` (number), `customOriginLng` (number), `truckId` (string), `driverId` (string), `notes` (string) | [grain, tons, loadDate, loadTime, truckCount, useOwnFleet] |
| `confirm_create_freight` | Crea el flete preparado con prepare_freight | — | [] |
| `duplicate_freight` | Duplica un flete existente con nueva fecha | `code` (string), `loadDate` (string), `loadTime` (string) | [code, loadDate] |
| `update_freight` | Modifica un flete existente | `code` (string), `loadDate` (string), `loadTime` (string), `notes` (string), `useOwnFleet` (boolean), `destPlantId` (string), `truckId` (string), `driverId` (string), `truckCount` (number) | [code] |

### Generic Confirmation

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `confirm_action` | Ejecuta una acción previamente preparada | — | [] |

### Freight Actions

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `accept_freight` | Acepta un flete asignado | `code` (string) | [code] |
| `reject_freight` | Rechaza un flete asignado | `code` (string), `reason` (string) | [code, reason] |
| `start_freight` | Inicia el viaje de un flete aceptado | `code` (string) | [code] |
| `confirm_loaded` | Confirma carga de un flete | `code` (string), `tons` (number) | [code, tons] |
| `confirm_finished` | Confirma entrega/recepción | `code` (string) | [code] |
| `cancel_freight` | Cancela un flete | `code` (string), `reason` (string) | [code, reason] |
| `authorize_freight` | Autoriza un flete con flota propia | `code` (string) | [code] |

### Multi-Truck Trips

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `respond_trip` | Acepta o rechaza un viaje específico | `code` (string), `assignmentId` (string), `action` (string, enum), `reason` (string) | [code, action] |
| `start_trip` | Inicia un viaje específico | `code` (string), `assignmentId` (string) | [code] |
| `confirm_trip_loaded` | Confirma carga de un viaje | `code` (string), `assignmentId` (string), `loadedTons` (number) | [code] |
| `confirm_trip_finished` | Confirma entrega de un viaje | `code` (string), `assignmentId` (string) | [code] |

### Transport Assignment

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `list_transporters` | Lista transportistas disponibles | `query` (string) | [] |
| `assign_transporter` | Asigna transportista a un flete | `code` (string), `transporterCompanyId` (string), `truckId` (string), `driverId` (string) | [code, transporterCompanyId] |
| `assign_truck_to_trip` | Asigna camión en un viaje existente | `code` (string), `truckId` (string), `driverId` (string) | [code, truckId] |
| `assign_truck_to_freight` | Asigna camión adicional a flete multi-camión | `code` (string), `transporterCompanyId` (string), `truckId` (string), `driverId` (string), `tons` (number) | [code, transporterCompanyId] |
| `assign_multi_trucks` | Asigna múltiples camiones a un flete | `code` (string), `trucks` (array of objects) | [code, trucks] |
| `cancel_assignment` | Cancela una asignación de camión | `code` (string), `assignmentId` (string), `reason` (string) | [code, reason] |
| `update_assignment` | Edita una asignación existente | `code` (string), `assignmentId` (string), `transporterCompanyId` (string), `truckId` (string), `driverId` (string), `tons` (number) | [code] |
| `approve_pending_change` | Aprueba un cambio pendiente | `code` (string), `changeId` (string) | [code] |
| `reject_pending_change` | Rechaza un cambio pendiente | `code` (string), `changeId` (string), `reason` (string) | [code] |

### Fields & Lots

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `search_plants` | Busca plantas/empresas destino por nombre (fuzzy) | `query` (string) | [query] |
| `list_fields` | Lista campos del productor | — | [] |
| `list_lots` | Lista lotes del productor | `fieldId` (string) | [] |
| `search_fields` | Busca campos por nombre (fuzzy) | `query` (string) | [query] |
| `search_lots` | Busca lotes por nombre (fuzzy) | `query` (string), `fieldId` (string) | [query] |
| `get_user_profile` | Retorna datos del perfil del usuario | — | [] |
| `create_field` | Crea un campo | `name` (string), `address` (string), `lat` (number), `lng` (number) | [name] |
| `create_lot` | Crea un lote dentro de un campo | `fieldId` (string), `name` (string), `hectares` (number), `lat` (number), `lng` (number) | [fieldId, name] |
| `update_field` | Modifica un campo existente | `fieldName` (string), `address` (string), `lat` (number), `lng` (number) | [fieldName] |
| `update_lot` | Modifica un lote existente | `lotName` (string), `hectares` (number), `lat` (number), `lng` (number) | [lotName] |

### Trucks & Drivers

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `list_trucks` | Lista camiones de la empresa | — | [] |
| `create_truck` | Registra un camión en la flota | `plate` (string), `model` (string) | [plate] |
| `update_truck` | Edita datos de un camión | `truckId` (string), `plate` (string), `brand` (string), `model` (string), `capacity` (number) | [truckId] |
| `deactivate_truck` | Desactiva un camión | `truckId` (string) | [truckId] |
| `list_drivers` | Lista choferes de la empresa | — | [] |
| `create_driver` | Registra un nuevo chofer | `name` (string), `phone` (string) | [name] |
| `deactivate_driver` | Desactiva un chofer | `driverId` (string) | [driverId] |
| `view_driver_queue` | Cola de fletes asignados a un chofer | `driverId` (string) | [driverId] |
| `reorder_driver_queue` | Reordena la cola de fletes de un chofer | `driverId` (string), `orderedFreightIds` (array) | [driverId, orderedFreightIds] |

### Documents

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `attach_document` | Adjunta imagen/documento pendiente a un flete | `code` (string), `step` (string, enum) | [code] |
| `list_documents` | Lista documentos adjuntos de un flete | `code` (string) | [code] |
| `delete_document` | Elimina un documento de un flete | `code` (string), `documentId` (string) | [code, documentId] |
| `ocr_analyze` | Analiza imagen de documento con OCR | `url` (string), `docType` (string, enum) | [url] |
| `save_ocr_data` | Guarda datos OCR extraídos en un documento | `code` (string), `documentId` (string), `ocrData` (object) | [code, documentId, ocrData] |

### Locations & Maps

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `generate_location_link` | Genera link para elegir ubicación en mapa | `purpose` (string, enum) | [purpose] |
| `generate_tracking_link` | Link público para rastrear flete en vivo | `code` (string) | [code] |
| `generate_map_link` | Link para ver ubicación en mapa | `lat` (number), `lng` (number), `name` (string), `destLat` (number), `destLng` (number), `destName` (string) | [lat, lng, name] |
| `generate_report_link` | Link público para descargar PDF de un flete | `code` (string) | [code] |
| `generate_daily_map_link` | Link con mapa interactivo de fletes del día | — | [] |
| `generate_batch_report_link` | Link a pantalla de reportes web | `status` (string), `dateFrom` (string), `dateTo` (string) | [] |
| `share_live_location` | Link para compartir ubicación en vivo | `code` (string) | [code] |
| `view_live_locations` | Link para ver ubicaciones en vivo | `code` (string) | [code] |
| `request_location` | Envía mensaje pidiendo compartir ubicación | `code` (string) | [code] |

### User Management

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `list_company_users` | Lista usuarios de la empresa | — | [] |
| `create_user` | Crea usuario en la empresa | `name` (string), `email` (string), `phone` (string), `role` (string, enum) | [name, email] |
| `update_user_role` | Cambia rol de un usuario | `userIdentifier` (string), `newRole` (string, enum) | [userIdentifier, newRole] |
| `deactivate_user` | Desactiva un usuario | `userIdentifier` (string) | [userIdentifier] |
| `reactivate_user` | Reactiva un usuario desactivado | `userIdentifier` (string) | [userIdentifier] |
| `update_user_admin` | Edita un usuario (admin) | `userId` (string), `name` (string), `email` (string), `phone` (string), `role` (string, enum), `active` (boolean) | [userId] |
| `update_profile` | Modifica perfil del usuario actual | `name` (string), `email` (string), `phone` (string) | [] |

### Company

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `switch_company` | Cambia empresa activa | `companyId` (string) | [] |
| `update_company` | Edita datos de empresa activa | `name` (string), `address` (string), `phone` (string), `email` (string), `lat` (number), `lng` (number) | [] |

### Plant-Producer Access

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `list_enabled_plants` | Lista plantas habilitadas para el productor | — | [] |
| `list_enabled_producers` | Lista productores habilitados en la planta | — | [] |
| `grant_producer_access` | Habilita un productor para la planta | `producerCompanyId` (string), `producerUserId` (string) | [producerCompanyId] |
| `revoke_producer_access` | Revoca acceso de productor a la planta | `accessId` (string) | [accessId] |

### Branches

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `list_branches` | Lista sucursales de la empresa | — | [] |
| `create_branch` | Crea sucursal para la empresa | `name` (string), `address` (string), `reference` (string), `lat` (number), `lng` (number) | [name] |
| `update_branch` | Edita sucursal existente | `branchId` (string), `name` (string), `address` (string), `reference` (string), `lat` (number), `lng` (number) | [branchId] |
| `delete_branch` | Desactiva una sucursal | `branchId` (string) | [branchId] |

### Web Navigation

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `navigate_app` | Navega al usuario a una pantalla de la app web | `screen` (string, enum), `freightId` (string) | [screen] |

### Assignment Suggestions

| Tool | Description | Properties | Required |
|------|-------------|------------|----------|
| `get_assignment_suggestions` | Obtiene sugerencias rankeadas de transporte | `freightId` (string) | [freightId] |

---

## 3. Intent Router

File: `src/ai/routing/intent-router.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { MODEL_ID, MODEL_ID_FAST } from '../ai.constants';
import { resolveActiveRole, hasType } from '../ai.utils';
import { AI_TOOL_DEFINITIONS } from '../ai-tool-definitions';

@Injectable()
export class IntentRouterService {

  private readonly tools = AI_TOOL_DEFINITIONS;

  // ======================== TOOL SETS BY ROLE ========================

  private static readonly CORE_TOOLS = new Set([
    'confirm_action', 'confirm_create_freight', 'list_freights', 'get_freight_detail',
    'summarize_freights', 'update_profile', 'get_user_profile',
  ]);

  private static readonly CHOFER_TOOLS = new Set([
    'accept_freight', 'reject_freight', 'start_freight', 'confirm_loaded',
    'confirm_finished', 'get_freight_detail', 'list_freights', 'generate_tracking_link',
    'share_live_location', 'view_live_locations', 'request_location', 'confirm_action',
    'respond_trip', 'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished',
    'update_profile', 'ocr_analyze',
  ]);

  private static readonly PRODUCER_TOOLS = new Set([
    'prepare_freight', 'list_lots', 'list_fields', 'search_fields', 'search_lots',
    'create_field', 'create_lot',
    'search_plants', 'list_trucks', 'create_truck', 'generate_location_link',
    'duplicate_freight', 'update_field', 'update_lot', 'cancel_freight',
    'list_enabled_plants', 'assign_truck_to_freight', 'cancel_assignment',
    'list_drivers',
  ]);

  private static readonly PLANT_TOOLS = new Set([
    'search_plants', 'list_transporters', 'assign_transporter', 'assign_truck_to_trip',
    'assign_truck_to_freight', 'list_trucks', 'list_drivers', 'authorize_freight',
    'cancel_assignment', 'update_assignment', 'cancel_freight',
    'assign_multi_trucks', 'view_driver_queue', 'reorder_driver_queue',
    'list_enabled_producers', 'grant_producer_access', 'revoke_producer_access',
    'get_assignment_suggestions',
  ]);

  private static readonly TRANSPORTER_TOOLS = new Set([
    'accept_freight', 'reject_freight', 'start_freight', 'confirm_loaded',
    'confirm_finished', 'respond_trip', 'start_trip', 'confirm_trip_loaded',
    'confirm_trip_finished', 'list_trucks', 'list_drivers',
    'deactivate_truck', 'deactivate_driver',
  ]);

  private static readonly TRACKING_TOOLS = new Set([
    'generate_tracking_link', 'generate_map_link', 'generate_report_link',
    'generate_daily_map_link', 'share_live_location', 'view_live_locations',
    'request_location',
  ]);

  private static readonly ANALYTICS_TOOLS = new Set([
    'get_dashboard', 'list_documents', 'freight_history', 'update_freight',
    'attach_document', 'ocr_analyze', 'generate_batch_report_link',
    'delete_document', 'save_ocr_data',
  ]);

  private static readonly ADMIN_TOOLS = new Set([
    'create_user', 'update_user_role', 'deactivate_user', 'reactivate_user',
    'list_company_users', 'list_drivers', 'create_driver',
    'update_truck', 'deactivate_truck', 'deactivate_driver',
    'list_branches', 'create_branch', 'update_branch', 'delete_branch',
    'update_company', 'update_user_admin',
  ]);

  private static readonly MULTI_COMPANY_TOOLS = new Set(['switch_company']);
  private static readonly PENDING_CHANGE_TOOLS = new Set(['approve_pending_change', 'reject_pending_change']);

  // ======================== MODEL SELECTION ========================

  selectModel(message: string, hasHistory: boolean): string {
    const lower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const simplePatterns = [
      /^(hola|buenas|buen dia|buenos dias|hey|che)\b/,
      /^(si|no|ok|dale|listo|perfecto|gracias|confirmo|cancelo)\b/,
      /\b(estado|status)\b.{0,20}\b(flete|flt)/,
      /^(mis fletes|fletes pendientes|pendientes)/,
      /^(resumen del dia|resumen diario)/,
      /\b(como (van|estan|esta)|que hay de nuevo)\b/,
    ];
    const complexPatterns = [
      /\b(crear|creat|nuevo flete|solicitar|agendar)\b/,
      /\b(analiz|compar|recomiend|optimiz|reporte detallado)\b/,
      /\b(cambiar empresa|switch|modificar)\b/,
      /\b(adjunt|document|archivo)\b/,
    ];
    if (complexPatterns.some(p => p.test(lower))) return MODEL_ID;
    if (!hasHistory && simplePatterns.some(p => p.test(lower))) return MODEL_ID_FAST;
    if (message.length < 40 && simplePatterns.some(p => p.test(lower))) return MODEL_ID_FAST;
    return MODEL_ID;
  }

  // ======================== TOOL FILTERING ========================

  getFilteredTools(user: any, companyType: string, isWeb = false): any[] {
    const { isChofer, isAdmin } = resolveActiveRole(user);
    const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
    const hasMultiCompany = activeMemberships.length > 1;

    if (isChofer && !isAdmin) {
      return this.tools.filter(t => IntentRouterService.CHOFER_TOOLS.has(t.name));
    }

    const allowed = new Set<string>(IntentRouterService.CORE_TOOLS);
    for (const t of IntentRouterService.TRACKING_TOOLS) allowed.add(t);
    for (const t of IntentRouterService.ANALYTICS_TOOLS) allowed.add(t);

    if (hasType(companyType, 'producer')) {
      for (const t of IntentRouterService.PRODUCER_TOOLS) allowed.add(t);
    }
    if (hasType(companyType, 'plant')) {
      for (const t of IntentRouterService.PLANT_TOOLS) allowed.add(t);
      for (const t of IntentRouterService.PENDING_CHANGE_TOOLS) allowed.add(t);
    }
    if (hasType(companyType, 'transporter')) {
      for (const t of IntentRouterService.TRANSPORTER_TOOLS) allowed.add(t);
    }
    if (isAdmin) {
      for (const t of IntentRouterService.ADMIN_TOOLS) allowed.add(t);
    }
    if (hasMultiCompany) {
      for (const t of IntentRouterService.MULTI_COMPANY_TOOLS) allowed.add(t);
    }
    if (isWeb) allowed.add('navigate_app');

    return this.tools.filter(t => allowed.has(t.name));
  }

  // ======================== MESSAGE PREPROCESSING ========================

  private static readonly NUMBER_WORDS: Record<string, string> = {
    cero:'0',uno:'1',una:'1',dos:'2',tres:'3',cuatro:'4',cinco:'5',
    seis:'6',siete:'7',ocho:'8',nueve:'9',diez:'10',
    once:'11',doce:'12',trece:'13',catorce:'14',quince:'15',
    veinte:'20',veintiuno:'21',veintidos:'22',veinticinco:'25',
    treinta:'30',cuarenta:'40',cincuenta:'50',sesenta:'60',
    setenta:'70',ochenta:'80',noventa:'90',cien:'100',
  };

  normalizeSpokenNumbers(text: string): string {
    let result = text;
    for (const [word, num] of Object.entries(IntentRouterService.NUMBER_WORDS)) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), num);
    }
    result = result.replace(/\b(\d+)\s+y\s+(\d+)\b/g, (_, a, b) => String(Number(a) + Number(b)));
    return result;
  }
}
```

---

## 4. Session Manager

File: `src/ai/session/session-manager.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { MAX_HISTORY } from '../ai.constants';

@Injectable()
export class SessionManagerService {
  private _chatSideEffects: Map<string, Record<string, any>> = new Map();

  // ======================== SIDE-EFFECTS ========================

  getSideEffects(sessionId: string): Record<string, any> {
    return this._chatSideEffects.get(sessionId) || {};
  }

  setSideEffects(sessionId: string, effects: Record<string, any>): void {
    effects._ts = effects._ts || Date.now();
    this._chatSideEffects.set(sessionId, effects);
  }

  deleteSideEffects(sessionId: string): void {
    this._chatSideEffects.delete(sessionId);
  }

  cleanStaleSideEffects(): void {
    const now = Date.now();
    for (const [k, v] of this._chatSideEffects) {
      if (v._ts && now - v._ts > 10 * 60 * 1000) this._chatSideEffects.delete(k);
      else if (!v._ts) this._chatSideEffects.delete(k);
    }
    if (this._chatSideEffects.size > 5_000) {
      const iter = this._chatSideEffects.keys();
      while (this._chatSideEffects.size > 4_000) {
        const k = iter.next().value;
        if (k) this._chatSideEffects.delete(k); else break;
      }
    }
  }

  // ======================== ACTIVE CONTEXT ========================

  updateActiveContext(sessionId: string, context: Record<string, any>): void {
    const effects = this._chatSideEffects.get(sessionId) || {};
    effects.activeContext = {
      ...(effects.activeContext || {}),
      ...context,
      updatedAt: new Date().toISOString(),
    };
    effects._ts = effects._ts || Date.now();
    this._chatSideEffects.set(sessionId, effects);
  }

  // ======================== PENDING SELECTION ========================

  storePendingSelection(
    sessionId: string,
    items: { id: string; title: string; description?: string }[],
    config: { headerText: string; listButtonLabel: string; sectionTitle: string },
    purpose: string,
    extraJson?: Record<string, any>,
  ): string {
    const effects = this._chatSideEffects.get(sessionId) || {};
    effects._pendingSelection = { items, config, purpose };
    effects._ts = effects._ts || Date.now();
    this._chatSideEffects.set(sessionId, effects);
    return JSON.stringify({
      total: items.length,
      message: `Se presento lista interactiva de ${items.length} elemento(s). Espere a que seleccione uno.`,
      _selectionSent: true,
      ...extraJson,
    });
  }

  // ======================== ACTION STAGING ========================

  stageAction(
    sessionId: string,
    tool: string,
    params: Record<string, any>,
    summary: string,
    user?: any,
  ): string {
    const effects = this._chatSideEffects.get(sessionId) || {};
    const stagedCompanyId = user?.activeCompanyId || user?.companyId || params?.actionSynUser?.companyId || null;
    effects.pendingAction = { tool, params, summary, createdAt: Date.now(), stagedCompanyId };
    effects._pendingButtons = [
      { id: 'ai_confirm', title: 'CONFIRMAR' },
      { id: 'ai_cancel', title: 'CANCELAR' },
    ];
    effects._ts = effects._ts || Date.now();
    this._chatSideEffects.set(sessionId, effects);

    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      IMPORTANT: 'La acción NO fue ejecutada todavía. Presente el resumen y consulte al usuario si confirma. Se enviarán botones CONFIRMAR/CANCELAR automáticamente.',
    });
  }

  // ======================== HISTORY TRIMMING ========================

  smartTrimHistory(messages: any[]): any[] {
    if (messages.length <= MAX_HISTORY) return messages;

    let trimmed = messages.slice(-MAX_HISTORY);

    while (trimmed.length > 0) {
      const first = trimmed[0];
      const hasToolResult = first.role === 'user' && Array.isArray(first.content) &&
        first.content.some((b: any) => b.type === 'tool_result');
      if (hasToolResult) {
        trimmed = trimmed.slice(1);
      } else {
        break;
      }
    }

    while (trimmed.length > 0) {
      const last = trimmed[trimmed.length - 1];
      const hasToolUse = last.role === 'assistant' && Array.isArray(last.content) &&
        last.content.some((b: any) => b.type === 'tool_use');
      if (hasToolUse) {
        trimmed = trimmed.slice(0, -1);
      } else {
        break;
      }
    }

    if (trimmed.length === 0 && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && (!Array.isArray(m.content) || !m.content.some((b: any) => b.type === 'tool_result')));
      if (lastUserMsg) return [lastUserMsg];
      return messages.slice(-1);
    }

    return trimmed;
  }
}
```

---

## 5. Response Formatter

File: `src/ai/response/response-formatter.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { MAX_RESPONSE_CHARS, AUDIO_FILLERS } from '../ai.constants';

@Injectable()
export class ResponseFormatterService {

  preprocessMessage(text: string): string {
    let clean = text
      .replace(AUDIO_FILLERS, ' ')
      .replace(/\bv\s+corta\b/gi, 'v')
      .replace(/\bb\s+larga\b/gi, 'b')
      .replace(/\bese\s+de\b/gi, 's')
      .replace(/\bdoble\s+ele\b/gi, 'll')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,.:;]+/, '')
      .trim();
    return clean || text.trim();
  }

  validateResponse(text: string, isWeb = false): string {
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    let clean = text.replace(UUID_RE, (match, offset) => {
      const before = text.slice(Math.max(0, offset - 80), offset);
      if (/https?:\/\/\S*$/i.test(before)) return match;
      return '[ID interno]';
    });

    if (!isWeb && clean.length > MAX_RESPONSE_CHARS && !/F\d{2}-[A-Z]{3}\.\d{4}|FLT-\d{4,}/i.test(clean)) {
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

    return clean.replace(/\n{3,}/g, '\n\n').trim();
  }
}
```

---

## 6. Tool Filtering by Role

Based on `IntentRouterService.getFilteredTools()`:

| Tool | Chofer | Producer | Plant | Transporter | Admin | All Roles (CORE+TRACKING+ANALYTICS) |
|------|--------|----------|-------|-------------|-------|--------------------------------------|
| `confirm_action` | Yes | Yes | Yes | Yes | Yes | CORE |
| `confirm_create_freight` | — | Yes | Yes | Yes | Yes | CORE |
| `list_freights` | Yes | Yes | Yes | Yes | Yes | CORE |
| `get_freight_detail` | Yes | Yes | Yes | Yes | Yes | CORE |
| `summarize_freights` | — | Yes | Yes | Yes | Yes | CORE |
| `update_profile` | Yes | Yes | Yes | Yes | Yes | CORE |
| `get_user_profile` | — | Yes | Yes | Yes | Yes | CORE |
| `accept_freight` | Yes | — | — | Yes | — | — |
| `reject_freight` | Yes | — | — | Yes | — | — |
| `start_freight` | Yes | — | — | Yes | — | — |
| `confirm_loaded` | Yes | — | — | Yes | — | — |
| `confirm_finished` | Yes | — | — | Yes | — | — |
| `generate_tracking_link` | Yes | Yes | Yes | Yes | Yes | TRACKING |
| `share_live_location` | Yes | Yes | Yes | Yes | Yes | TRACKING |
| `view_live_locations` | Yes | Yes | Yes | Yes | Yes | TRACKING |
| `request_location` | Yes | Yes | Yes | Yes | Yes | TRACKING |
| `respond_trip` | Yes | — | — | Yes | — | — |
| `start_trip` | Yes | — | — | Yes | — | — |
| `confirm_trip_loaded` | Yes | — | — | Yes | — | — |
| `confirm_trip_finished` | Yes | — | — | Yes | — | — |
| `ocr_analyze` | Yes | Yes | Yes | Yes | Yes | ANALYTICS |
| `prepare_freight` | — | Yes | — | — | — | — |
| `list_lots` | — | Yes | — | — | — | — |
| `list_fields` | — | Yes | — | — | — | — |
| `search_fields` | — | Yes | — | — | — | — |
| `search_lots` | — | Yes | — | — | — | — |
| `create_field` | — | Yes | — | — | — | — |
| `create_lot` | — | Yes | — | — | — | — |
| `search_plants` | — | Yes | Yes | — | — | — |
| `list_trucks` | — | Yes | Yes | Yes | — | — |
| `create_truck` | — | Yes | — | — | — | — |
| `generate_location_link` | — | Yes | — | — | — | — |
| `duplicate_freight` | — | Yes | — | — | — | — |
| `update_field` | — | Yes | — | — | — | — |
| `update_lot` | — | Yes | — | — | — | — |
| `cancel_freight` | — | Yes | Yes | — | — | — |
| `list_enabled_plants` | — | Yes | — | — | — | — |
| `assign_truck_to_freight` | — | Yes | Yes | — | — | — |
| `cancel_assignment` | — | Yes | Yes | — | — | — |
| `list_drivers` | — | Yes | Yes | Yes | Yes | — |
| `list_transporters` | — | — | Yes | — | — | — |
| `assign_transporter` | — | — | Yes | — | — | — |
| `assign_truck_to_trip` | — | — | Yes | — | — | — |
| `authorize_freight` | — | — | Yes | — | — | — |
| `update_assignment` | — | — | Yes | — | — | — |
| `assign_multi_trucks` | — | — | Yes | — | — | — |
| `view_driver_queue` | — | — | Yes | — | — | — |
| `reorder_driver_queue` | — | — | Yes | — | — | — |
| `list_enabled_producers` | — | — | Yes | — | — | — |
| `grant_producer_access` | — | — | Yes | — | — | — |
| `revoke_producer_access` | — | — | Yes | — | — | — |
| `get_assignment_suggestions` | — | — | Yes | — | — | — |
| `approve_pending_change` | — | — | Yes | — | — | — |
| `reject_pending_change` | — | — | Yes | — | — | — |
| `deactivate_truck` | — | — | — | Yes | Yes | — |
| `deactivate_driver` | — | — | — | Yes | Yes | — |
| `get_dashboard` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `list_documents` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `freight_history` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `update_freight` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `attach_document` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `generate_batch_report_link` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `delete_document` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `save_ocr_data` | — | Yes | Yes | Yes | Yes | ANALYTICS |
| `generate_map_link` | — | Yes | Yes | Yes | Yes | TRACKING |
| `generate_report_link` | — | Yes | Yes | Yes | Yes | TRACKING |
| `generate_daily_map_link` | — | Yes | Yes | Yes | Yes | TRACKING |
| `create_user` | — | — | — | — | Yes | — |
| `update_user_role` | — | — | — | — | Yes | — |
| `deactivate_user` | — | — | — | — | Yes | — |
| `reactivate_user` | — | — | — | — | Yes | — |
| `list_company_users` | — | — | — | — | Yes | — |
| `create_driver` | — | — | — | — | Yes | — |
| `update_truck` | — | — | — | — | Yes | — |
| `list_branches` | — | — | — | — | Yes | — |
| `create_branch` | — | — | — | — | Yes | — |
| `update_branch` | — | — | — | — | Yes | — |
| `delete_branch` | — | — | — | — | Yes | — |
| `update_company` | — | — | — | — | Yes | — |
| `update_user_admin` | — | — | — | — | Yes | — |
| `switch_company` | — | Multi-co | Multi-co | Multi-co | Multi-co | — |
| `navigate_app` | — | Web only | Web only | Web only | Web only | — |

**Note:** Chofer gets a SEPARATE dedicated tool set (not CORE+extras). Non-chofer roles always get CORE + TRACKING + ANALYTICS as a base, then role-specific tools added on top.

---

## 7. Orchestrator (chat method)

File: `src/ai/ai.service.ts`

```typescript
async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: { screen: string; freightId?: string } }> {
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

    // Per-session lock
    if (this._chatLocks.has(session.id)) {
      return { text: 'Estoy procesando su mensaje anterior, aguarde un momento.' };
    }
    this._chatLocks.add(session.id);

    // WhatsApp session company override
    const sessionState = (session?.flowState as any) || {};
    const sessionCompanyId = sessionState.selectedCompanyId;
    if (sessionCompanyId && sessionCompanyId !== user.activeCompanyId) {
      const isMember = (user.memberships || []).some((m: any) => m.companyId === sessionCompanyId && m.active !== false);
      if (isMember) {
        user.activeCompanyId = sessionCompanyId;
      }
    }

    const synUser = this.aiContext.buildSyntheticUser(user);
    const companyType = this.aiContext.resolveCompanyType(user);
    const isWeb = phone === 'web';
    const systemPrompt = await this.promptBuilder.build(user, companyType, isWeb);

    const cappedMessage = userMessage.length > 5000 ? userMessage.slice(0, 5000) : userMessage;
    const cleanedMessage = this.responseFormatter.preprocessMessage(cappedMessage);

    const state = (session?.flowState as any) || {};
    const aiMessages: any[] = state.aiMessages || [];

    // Stale session detection
    let messageToSend = cleanedMessage;
    const lastMsgTime = state.lastMessageAt ? new Date(state.lastMessageAt).getTime() : 0;
    if (lastMsgTime && aiMessages.length > 0) {
      const minutesGap = (Date.now() - lastMsgTime) / 60000;
      if (minutesGap > STALE_SESSION_MIN) {
        messageToSend = `[Sistema: pasaron ${Math.round(minutesGap)} min desde el último mensaje. El usuario puede estar retomando o cambiando de tema.]\n\n${cleanedMessage}`;
      }
    }

    // Pending document injection
    if (state.pendingDocument) {
      const doc = state.pendingDocument;
      const safeName = (doc.name || '').replace(/[^\w\s.\-()áéíóúñÁÉÍÓÚÑ]/g, '').slice(0, 60);
      const ctxFreight = state.activeContext?.lastFreightCode
        ? ` El último flete consultado fue ${this.sanitizeForPrompt(state.activeContext.lastFreightCode)} (${this.sanitizeForPrompt(state.activeContext.lastFreightSummary || '')}).`
        : '';
      messageToSend = `[Sistema: HAY UN ARCHIVO PENDIENTE de adjuntar — "${safeName}" (${doc.type}).${ctxFreight} Si el usuario indica un código de flete o hace referencia al flete anterior, usar attach_document DIRECTAMENTE. NO usar list_freights.]\n\n${messageToSend}`;
    }

    // Active context injection
    if (state.activeContext && !state.pendingDocument) {
      const ac = state.activeContext;
      const parts: string[] = [];
      if (ac.lastFreightCode) {
        parts.push(`último flete: ${this.sanitizeForPrompt(ac.lastFreightCode)} — ${this.sanitizeForPrompt(ac.lastFreightSummary || '')}`);
      }
      if (ac.lastAction) {
        parts.push(`última acción: ${this.sanitizeForPrompt(ac.lastAction)}`);
      }
      if (ac.lastSearchFilter) {
        parts.push(`último filtro: ${this.sanitizeForPrompt(ac.lastSearchFilter)}`);
      }
      if (parts.length > 0) {
        messageToSend = `[Contexto activo: ${parts.join('. ')}]\n\n${messageToSend}`;
      }
    }

    // Recovered context from expired session
    if (state._sessionExpiredNote && state._recoveredContext) {
      const rc = state._recoveredContext;
      const parts: string[] = [];
      if (rc.lastFreightCode) parts.push(`último flete: ${this.sanitizeForPrompt(rc.lastFreightCode)}`);
      if (rc.lastAction) parts.push(`última acción: ${this.sanitizeForPrompt(rc.lastAction)}`);
      if (rc.lastSearchFilter) parts.push(`último filtro: ${this.sanitizeForPrompt(rc.lastSearchFilter)}`);
      if (parts.length > 0) {
        messageToSend = `[Sistema: la sesión anterior expiró. Contexto recuperado: ${parts.join('. ')}. Informar brevemente al usuario que su sesión anterior expiró y ofrecerse a retomar.]\n\n${messageToSend}`;
      }
    }

    // Pending action injection
    if (state.pendingAction) {
      const pa = state.pendingAction;
      messageToSend = `[Sistema: hay una acción pendiente de confirmación: ${this.sanitizeForPrompt(pa.summary || pa.tool || '')}. Si el usuario confirma → confirm_action. Si cancela o cambia de tema → ignorar la acción pendiente.]\n\n${messageToSend}`;
    }

    aiMessages.push({ role: 'user', content: messageToSend });
    const trimmed = this.sessionManager.smartTrimHistory(aiMessages);

    let response: any;
    let loopCount = 0;
    const currentMessages = [...trimmed];

    this._chatSideEffects.delete(session.id);

    const filteredTools = this.getFilteredTools(user, companyType, isWeb);
    const selectedModel = this.selectModel(cleanedMessage, aiMessages.length > 0);

    const loopDeadline = Date.now() + 90_000;

    try {
      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        if (Date.now() > loopDeadline) break;

        const modelForLoop = loopCount === 1 ? selectedModel : MODEL_ID;
        const createParams = {
          model: modelForLoop,
          max_tokens: isWeb ? 2400 : MODEL_MAX_TOKENS,
          temperature: MODEL_TEMPERATURE,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: filteredTools.map((t, i, arr) =>
            i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
          ) as any,
          messages: currentMessages,
        };

        // Claude API call with 1 retry on transient errors
        const callClaude = async (): Promise<any> => {
          let timeoutHandle: ReturnType<typeof setTimeout>;
          const timeout = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Claude API timeout')), 45_000);
          });
          try {
            if (onDelta) {
              let isFirst = true;
              const stream = this.client.messages.stream(createParams as any);
              stream.on('text', (text) => { try { onDelta(text, isFirst); isFirst = false; } catch {} });
              const streamResult = Promise.resolve(stream.finalMessage());
              return await Promise.race([streamResult, timeout]);
            } else {
              const apiCall = this.client.messages.create(createParams as any);
              return await Promise.race([apiCall, timeout]);
            }
          } finally {
            clearTimeout(timeoutHandle!);
          }
        };
        try {
          response = await callClaude();
        } catch (retryErr: any) {
          const status = retryErr?.status || retryErr?.statusCode;
          const isTransient = !status || status === 529 || status >= 500 || retryErr.message?.includes('timeout');
          if (isTransient && Date.now() + 50_000 < loopDeadline) {
            await new Promise(r => setTimeout(r, 2000));
            response = await callClaude();
          } else {
            throw retryErr;
          }
        }

        if (response.stop_reason === 'tool_use') {
          currentMessages.push({ role: 'assistant', content: response.content });

          const READ_ONLY_TOOLS = new Set([
            'list_freights', 'get_freight_detail', 'search_plants', 'list_lots', 'list_fields',
            'search_fields', 'search_lots', 'get_user_profile',
            'list_transporters', 'list_trucks', 'list_company_users', 'list_drivers', 'summarize_freights',
            'list_documents', 'freight_history', 'get_dashboard',
            'generate_tracking_link', 'generate_map_link', 'generate_report_link', 'generate_daily_map_link',
            'navigate_app',
          ]);

          const toolBlocks = response.content.filter((b: any) => b.type === 'tool_use');
          const allReadOnly = toolBlocks.every((b: any) => READ_ONLY_TOOLS.has(b.name));

          let toolResults: any[];
          if (allReadOnly && toolBlocks.length > 1) {
            const settled = await Promise.allSettled(toolBlocks.map(async (block: any) => {
              const result = await this.executeTool(block.name, block.input, user, synUser, session);
              return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
            }));
            toolResults = settled.map((s, i) =>
              s.status === 'fulfilled'
                ? s.value
                : { type: 'tool_result' as const, tool_use_id: toolBlocks[i].id, content: 'Error: ' + (s.reason?.message || 'Unknown error'), is_error: true },
            );
          } else {
            toolResults = [];
            for (const block of toolBlocks) {
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

      // Loop exhaustion fallback
      if (response.stop_reason === 'tool_use' && loopCount >= MAX_TOOL_LOOPS) {
        const partialText = response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
          .trim();
        if (partialText) {
          response = { ...response, stop_reason: 'end_turn', content: [{ type: 'text', text: partialText }] };
        } else {
          const activeCtx = state.activeContext?.lastFreightCode
            ? ` sobre el flete ${state.activeContext.lastFreightCode}`
            : '';
          response = { ...response, stop_reason: 'end_turn', content: [{ type: 'text', text: `La operación${activeCtx} requiere más pasos de los que puedo completar en una sola interacción. Por favor, intente con un pedido más específico o utilice la plataforma web: ${APP_URL}` }] };
        }
      }

      const textBlocks = response.content.filter((b: any) => b.type === 'text');
      let finalText = textBlocks.map((b: any) => b.text).join('\n') || 'No se pudo procesar el mensaje.';
      finalText = this.responseFormatter.validateResponse(finalText, isWeb);

      currentMessages.push({ role: 'assistant', content: response.content });

      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};
      const latestFlowStep = freshSession?.flowStep ?? session.flowStep;
      const latestFlowType = freshSession?.flowType ?? session.flowType;

      const sideEffects = this._chatSideEffects.get(session.id) || {};
      this._chatSideEffects.delete(session.id);

      const pendingButtons = sideEffects._pendingButtons || latestState._pendingButtons || undefined;
      const { _pendingButtons: _dbBtns, _sessionExpiredNote: _expNote, _recoveredContext: _recCtx, ...cleanState } = latestState;
      const { _pendingButtons: _seBtns, _clearAiMessages, activeContext: seActiveContext, _navigate, ...otherSideEffects } = sideEffects;

      const mergedActiveContext = seActiveContext
        ? { ...(cleanState.activeContext || {}), ...seActiveContext }
        : cleanState.activeContext;

      const trimmedMessages = currentMessages.slice(-MAX_HISTORY).map((msg, idx, arr) => {
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
          ...otherSideEffects,
          ...(mergedActiveContext ? { activeContext: mergedActiveContext } : {}),
          aiMessages: _clearAiMessages ? [] : trimmedMessages,
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

      return { text: finalText, buttons: pendingButtons, navigate: _navigate };
    } catch (e) {
      this._chatSideEffects.delete(session.id);
      this.logger.error(`Chat error [session=${session.id} user=${user.id} company=${user.activeCompanyId}]: ${e.message}`, e.stack?.slice(0, 500));
      return { text: 'Se produjo un inconveniente técnico. Por favor, intente nuevamente o utilice las opciones del menú.' };
    } finally {
      this._chatLocks.delete(session.id);
    }
  }
```

### Tool Dispatcher (`_executeToolInner`)

```typescript
  private async _executeToolInner(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
  ): Promise<string> {
      switch (toolName) {
        // ---- Freight Queries (read-only) ----
        case 'list_freights': return await this.freightQueryTools.toolListFreights(synUser, input, session);
        case 'get_freight_detail': return await this.freightQueryTools.toolGetFreightDetail(input, user, session);
        case 'summarize_freights': return await this.freightQueryTools.toolSummarizeFreights(synUser, input);
        case 'get_dashboard': return await this.freightQueryTools.toolGetDashboard(user);
        case 'freight_history': return await this.freightQueryTools.toolFreightHistory(input, user);
        case 'list_documents': return await this.freightQueryTools.toolListDocuments(input, user);
        case 'search_plants': return await this.freightQueryTools.toolSearchPlants(input, user, session);
        case 'list_lots': return await this.freightQueryTools.toolListLots(user, session, input);
        case 'list_fields': return await this.freightQueryTools.toolListFields(user, session);
        case 'search_fields': return await this.freightQueryTools.toolSearchFields(input, user);
        case 'search_lots': return await this.freightQueryTools.toolSearchLots(input, user);
        // ---- Freight Actions (mutations) ----
        case 'prepare_freight': return await this.freightActionTools.toolPrepareFreight(input, user, session);
        case 'confirm_create_freight': return await this.freightActionTools.toolConfirmCreateFreight(user, synUser, session);
        case 'confirm_action': return await this.freightActionTools.toolConfirmAction(user, synUser, session);
        case 'accept_freight': return await this.freightActionTools.toolAcceptFreight(input, user, synUser, session);
        case 'reject_freight': return await this.freightActionTools.toolRejectFreight(input, user, synUser, session);
        case 'start_freight': return await this.freightActionTools.toolStartFreight(input, user, synUser, session);
        case 'confirm_loaded': return await this.freightActionTools.toolConfirmLoaded(input, user, synUser, session);
        case 'confirm_finished': return await this.freightActionTools.toolConfirmFinished(input, user, synUser, session);
        case 'cancel_freight': return await this.freightActionTools.toolCancelFreight(input, user, synUser, session);
        case 'update_freight': return await this.freightActionTools.toolUpdateFreight(input, user, session);
        case 'duplicate_freight': return await this.freightActionTools.toolDuplicateFreight(input, user, synUser, session);
        case 'authorize_freight': return await this.freightActionTools.toolAuthorizeFreight(input, user, session);
        case 'approve_pending_change': return await this.freightActionTools.toolApprovePendingChange(input, user, session);
        case 'reject_pending_change': return await this.freightActionTools.toolRejectPendingChange(input, user, session);
        case 'respond_trip': return await this.freightActionTools.toolRespondTrip(input, user, session);
        case 'start_trip': return await this.freightActionTools.toolStartTrip(input, user, session);
        case 'confirm_trip_loaded': return await this.freightActionTools.toolConfirmTripLoaded(input, user, session);
        case 'confirm_trip_finished': return await this.freightActionTools.toolConfirmTripFinished(input, user, session);
        case 'create_field': return await this.freightActionTools.toolCreateField(input, user, session);
        case 'create_lot': return await this.freightActionTools.toolCreateLot(input, user, session);
        case 'update_field': return await this.freightActionTools.toolUpdateField(input, user, session);
        case 'update_lot': return await this.freightActionTools.toolUpdateLot(input, user, session);
        case 'attach_document': return await this.freightActionTools.toolAttachDocument(input, user, synUser, session);
        case 'delete_document': return await this.freightActionTools.toolDeleteDocument(input, user, session);
        case 'save_ocr_data': return await this.freightActionTools.toolSaveOcrData(input, user, session);
        case 'ocr_analyze': return await this.freightActionTools.toolOcrAnalyze(input, user, session);
        case 'reactivate_user': return await this.freightActionTools.toolReactivateUser(input, user, session);
        // ---- Transport & Assignment ----
        case 'list_trucks': return await this.transportTools.toolListTrucks(user, session);
        case 'create_truck': return await this.transportTools.toolCreateTruck(input, user, session);
        case 'list_transporters': return await this.transportTools.toolListTransporters(input, user, session);
        case 'assign_transporter': return await this.transportTools.toolAssignTransporter(input, user, synUser, session);
        case 'assign_truck_to_trip': return await this.transportTools.toolAssignTruckToTrip(input, user, synUser, session);
        case 'assign_truck_to_freight': return await this.transportTools.toolAssignTruckToFreight(input, user, synUser, session);
        case 'list_drivers': return await this.transportTools.toolListDrivers(user, session);
        case 'cancel_assignment': return await this.transportTools.toolCancelAssignment(input, user, session);
        case 'update_assignment': return await this.transportTools.toolUpdateAssignment(input, user, session);
        case 'create_driver': return await this.transportTools.toolCreateDriver(input, user, session);
        case 'deactivate_truck': return await this.transportTools.toolDeactivateTruck(input, user, session);
        case 'update_truck': return await this.transportTools.toolUpdateTruck(input, user, session);
        case 'deactivate_driver': return await this.transportTools.toolDeactivateDriver(input, user, session);
        case 'assign_multi_trucks': return await this.transportTools.toolAssignMultiTrucks(input, user, session);
        case 'view_driver_queue': return await this.transportTools.toolViewDriverQueue(input, user);
        case 'reorder_driver_queue': return await this.transportTools.toolReorderDriverQueue(input, user, session);
        // ---- Admin & User Management ----
        case 'get_user_profile': return this.adminTools.toolGetUserProfile(user);
        case 'create_user': return await this.adminTools.toolCreateUser(input, user, session);
        case 'list_company_users': return await this.adminTools.toolListCompanyUsers(user, session);
        case 'update_user_role': return await this.adminTools.toolUpdateUserRole(input, user, session);
        case 'deactivate_user': return await this.adminTools.toolDeactivateUser(input, user, session);
        case 'switch_company': return await this.adminTools.toolSwitchCompany(input, user, session);
        case 'update_profile': return await this.adminTools.toolUpdateProfile(input, user, session);
        case 'update_user_admin': return await this.adminTools.toolUpdateUserAdmin(input, user, session);
        case 'update_company': return await this.adminTools.toolUpdateCompany(input, user, session);
        case 'list_enabled_plants': return await this.adminTools.toolListEnabledPlants(user);
        case 'list_enabled_producers': return await this.adminTools.toolListEnabledProducers(user);
        case 'grant_producer_access': return await this.adminTools.toolGrantProducerAccess(input, user, session);
        case 'revoke_producer_access': return await this.adminTools.toolRevokeProducerAccess(input, user, session);
        case 'list_branches': return await this.adminTools.toolListBranches(user);
        case 'create_branch': return await this.adminTools.toolCreateBranch(input, user, session);
        case 'update_branch': return await this.adminTools.toolUpdateBranch(input, user, session);
        case 'delete_branch': return await this.adminTools.toolDeleteBranch(input, user, session);
        case 'get_assignment_suggestions': return await this.adminTools.toolGetAssignmentSuggestions(input, user);
        // ---- Location & Maps ----
        case 'generate_location_link': return this.locationTools.toolGenerateLocationLink(input, session);
        case 'generate_tracking_link': return await this.locationTools.toolGenerateTrackingLink(input, user);
        case 'generate_map_link': return await this.locationTools.toolGenerateMapLink(input);
        case 'generate_report_link': return await this.locationTools.toolGenerateReportLink(input, user);
        case 'generate_daily_map_link': return await this.locationTools.toolGenerateDailyMapLink(user);
        case 'generate_batch_report_link': return await this.locationTools.toolGenerateBatchReportLink(input, user);
        case 'share_live_location': return await this.locationTools.toolShareLiveLocation(input, user);
        case 'view_live_locations': return await this.locationTools.toolViewLiveLocations(input, user);
        case 'request_location': return await this.locationTools.toolRequestLocation(input, user);
        case 'navigate_app': return this.locationTools.toolNavigateApp(input, session);
        default: return JSON.stringify({ error: 'Herramienta no reconocida' });
    }
  }
```

---

## 8. WhatsApp Button Logic

File: `src/whatsapp/whatsapp-router.service.ts`

### `handleButtonReply()`

```typescript
  private async handleButtonReply(phone: string, user: any, buttonId: string, title: string) {
    const parts = buttonId.split(':');
    const action = parts[0];
    const entityId = parts[1] || '';

    const synUser = this.buildSyntheticUser(user);

    // Access check for freight actions
    const freightActions = ['accept', 'reject', 'start', 'confirm_loaded', 'confirm_finished', 'cancel', 'reassign', 'add_truck', 'remove_truck'];
    if (freightActions.includes(action) && entityId) {
      const freight = await this.prisma.freight.findUnique({
        where: { id: entityId },
        select: { originCompanyId: true, destCompanyId: true, assignments: { select: { transportCompanyId: true, driverId: true } } },
      }).catch(e => { this.logger.warn(e.message); return null; });
      if (!freight) {
        await this.wa.sendText(phone, 'Flete no encontrado.');
        return;
      }
      const activeCoId = user.activeCompanyId || user.companyId;
      const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
      const allUserCompanies = [activeCoId, ...memberCompanyIds].filter(Boolean);
      const canAccess = allUserCompanies.some(c => c === freight.originCompanyId || c === freight.destCompanyId)
        || freight.assignments.some(a => allUserCompanies.includes(a.transportCompanyId) || a.driverId === user.id);
      if (!canAccess) {
        await this.wa.sendText(phone, 'No tiene acceso a este flete.');
        return;
      }
    }

    try {
      switch (action) {
        case 'accept': {
          await this.freights.respond(entityId, { action: 'accepted' } as any, synUser);
          await this.wa.sendText(phone, '✅ Flete aceptado.');
          break;
        }
        case 'reject': {
          await this.flow.startFlow('reject_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'start': {
          await this.freights.start(entityId, synUser);
          await this.wa.sendText(phone, '🚛 Viaje iniciado.');
          break;
        }
        case 'confirm_loaded': {
          await this.flow.startFlow('confirm_loaded', phone, user, { freightId: entityId });
          break;
        }
        case 'confirm_finished': {
          await this.freights.confirmFinished(entityId, synUser);
          await this.wa.sendText(phone, '✅ Entrega confirmada.');
          break;
        }
        case 'cancel': {
          await this.flow.startFlow('cancel_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'reassign': {
          const reassignFreight = await this.prisma.freight.findUnique({
            where: { id: entityId },
            select: { code: true },
          });
          if (reassignFreight) {
            await this.handleAiChat(phone, user, `Quiero asignar un transportista al flete ${reassignFreight.code}`);
          } else {
            await this.wa.sendText(phone, 'Flete no encontrado.');
          }
          break;
        }
        case 'detail': {
          await this.showFreightDetail(phone, user, entityId);
          break;
        }
        case 'menu': {
          const menuSess = await this.prisma.whatsAppSession.findFirst({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { updatedAt: 'desc' } });
          await this.showMainMenu(phone, user, ((menuSess?.flowState as any) || {}).selectedCompanyId);
          break;
        }
        case 'active_freights': {
          await this.showActiveFreights(phone, user);
          break;
        }
        case 'create_freight': {
          await this.handleAiChat(phone, 'Quiero crear un flete', user);
          break;
        }
        case 'show_help': {
          await this.showHelp(phone, user);
          break;
        }
        case 'location_done': {
          await this.handleAiChat(phone, user, 'Ubicación confirmada.');
          break;
        }
        case 'add_truck': {
          const addFreight = await this.prisma.freight.findUnique({ where: { id: entityId }, select: { code: true } });
          if (addFreight) {
            await this.handleAiChat(phone, user, `Quiero agregar un camión al flete ${addFreight.code}`);
          } else {
            await this.wa.sendText(phone, 'Flete no encontrado.');
          }
          break;
        }
        case 'remove_truck': {
          const rmFreight = await this.prisma.freight.findUnique({ where: { id: entityId }, select: { code: true } });
          if (rmFreight) {
            await this.handleAiChat(phone, user, `Quiero quitar un camión del flete ${rmFreight.code}`);
          } else {
            await this.wa.sendText(phone, 'Flete no encontrado.');
          }
          break;
        }
        case 'ai_confirm_freight': {
          await this.handleAiChat(phone, user, 'Confirmar.');
          break;
        }
        case 'ai_cancel_freight': {
          await this.handleAiChat(phone, user, 'No, cancelar.');
          break;
        }
        case 'ai_confirm': {
          await this.handleAiChat(phone, user, 'Confirmar.');
          break;
        }
        case 'ai_cancel': {
          await this.handleAiChat(phone, user, 'No, cancelar.');
          break;
        }
        default: {
          await this.wa.sendText(phone, 'Acción no reconocida. Escriba "menu" para ver las opciones disponibles.');
        }
      }
    } catch (e) {
      this.logger.error(`Button action "${action}" failed: ${e.message}`, e.stack);
      const raw = String(e.message || '');
      const isSafe400 = (e.status === 400 || e.response?.statusCode === 400)
        && /no encontrad|no se puede|debe|requiere|invalido|ya.*asignad/i.test(raw);
      const userMessage = isSafe400
        ? raw.replace(/[^\w\sáéíóúñÁÉÍÓÚÑ.,;:()!?¿¡\-]/g, '').trim().slice(0, 200)
        : 'Ocurrió un error procesando su solicitud. Intente nuevamente.';
      await this.wa.sendText(phone, userMessage || 'Ocurrió un error procesando su solicitud.');
    }
  }
```

### `getRoleMenuButtons()`

```typescript
  private getRoleMenuButtons(role: string): Array<{ id: string; title: string }> {
    if (role === 'producer') {
      return [
        { id: 'active_freights', title: 'MIS FLETES' },
        { id: 'create_freight', title: 'SOLICITAR FLETE' },
        { id: 'show_help', title: 'GUÍA DE USO' },
      ];
    }
    if (role === 'plant') {
      return [
        { id: 'active_freights', title: 'FLETES PENDIENTES' },
        { id: 'show_help', title: 'GUÍA DE USO' },
      ];
    }
    if (role === 'transporter') {
      return [
        { id: 'active_freights', title: 'MIS ASIGNACIONES' },
        { id: 'show_help', title: 'GUÍA DE USO' },
      ];
    }
    return [
      { id: 'active_freights', title: 'MIS FLETES' },
      { id: 'create_freight', title: 'SOLICITAR FLETE' },
      { id: 'show_help', title: 'GUÍA DE USO' },
    ];
  }
```

### Confirmation Detection (ai_confirm / ai_cancel)

Button IDs `ai_confirm` and `ai_cancel` are handled in `handleButtonReply()` above. They translate button presses into synthetic AI messages:

- `ai_confirm` -> `handleAiChat(phone, user, 'Confirmar.')` -- AI sees "Confirmar." and calls `confirm_action`
- `ai_cancel` -> `handleAiChat(phone, user, 'No, cancelar.')` -- AI sees cancellation and drops pending action
- `ai_confirm_freight` -> `handleAiChat(phone, user, 'Confirmar.')` -- for freight creation specifically
- `ai_cancel_freight` -> `handleAiChat(phone, user, 'No, cancelar.')`

These buttons are injected by `SessionManagerService.stageAction()` which sets `_pendingButtons: [{ id: 'ai_confirm', title: 'CONFIRMAR' }, { id: 'ai_cancel', title: 'CANCELAR' }]`.

---

## 9. Proactive Notifications

File: `src/notifications/notification.service.ts`

### `sendWhatsAppDirect()`

```typescript
  private async sendWhatsAppDirect(
    userId: string,
    phone: string | null,
    type: NotificationType,
    title: string,
    body: string,
    entityId?: string,
    actionRecipient = false,
  ) {
    if (!this.wa) return;
    if (!this.wa.isEnabled()) return;

    let userPhone = phone;
    if (!userPhone) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true },
      });
      userPhone = user?.phone || null;
    }
    if (!userPhone) return;

    const canSend = await this.canSendProactive(userPhone);
    if (!canSend) return;

    const lastSent = this.proactiveLastSent.get(userPhone) || 0;
    if (Date.now() - lastSent < 60_000) return;

    const buttons = this.getWhatsAppButtons(type, entityId, actionRecipient);
    const text = `*${title}*\n${body}`;

    try {
      if (buttons.length > 0 && entityId) {
        await this.wa.sendButtons(userPhone, text, buttons);
      } else {
        await this.wa.sendText(userPhone, text);
      }
      this.proactiveLastSent.set(userPhone, Date.now());
    } catch (err) {
      this.logger.warn(`WhatsApp send failed for ${userPhone.slice(-4)}: ${err.message}`);
    }
  }
```

### `getWhatsAppButtons()`

```typescript
  private getWhatsAppButtons(type: NotificationType, entityId?: string, actionRecipient = false): Array<{ id: string; title: string }> {
    if (!entityId) return [];

    if (actionRecipient) {
      switch (type) {
        case 'freight_assigned':
          return [
            { id: `accept:${entityId}`, title: 'Aceptar' },
            { id: `reject:${entityId}`, title: 'Rechazar' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        case 'freight_loaded':
          return [
            { id: `confirm_loaded:${entityId}`, title: 'Confirmar' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        case 'freight_confirmed':
          return [
            { id: `confirm_finished:${entityId}`, title: 'Confirmar entrega' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        case 'freight_rejected':
          return [
            { id: `reassign:${entityId}`, title: 'Reasignar' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
      }
    }

    switch (type) {
      case 'freight_rejected':
        return [
          { id: `detail:${entityId}`, title: 'Ver detalle' },
        ];
      case 'freight_canceled':
        return [];
      default:
        return [
          { id: `detail:${entityId}`, title: 'Ver detalle' },
        ];
    }
  }
```

### `notifyCompany()`

```typescript
  async notifyCompany(
    companyId: string,
    type: NotificationType,
    title: string,
    body: string,
    entityId?: string,
    excludeUserId?: string,
    actionRecipient = false,
  ) {
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        memberships: { some: { companyId, active: true } },
      },
      select: { id: true, phone: true },
    });
    const userMap = new Map<string, string | null>();
    for (const u of users) {
      if (u.id !== excludeUserId) userMap.set(u.id, u.phone);
    }
    const userIds = Array.from(userMap.keys());

    if (userIds.length === 0) return;

    await this.prisma.notification.createMany({
      data: userIds.map(userId => ({ userId, type, title, body, entityId, companyId })),
    });

    for (const uid of userIds) {
      this.sendPush(uid, { title, body, url: entityId ? `/freight/${entityId}` : '/' })
        .catch((e) => this.logger.error(`Push send failed for user ${uid}: ${e.message}`));
      this.sse.emitToUser(uid, 'notification:new', { type, title, entityId });
    }

    this.sendWhatsAppBatch(userIds, userMap, type, title, body, entityId, actionRecipient)
      .catch((e) => this.logger.error(`WhatsApp batch send failed: ${e.message}`));
  }
```

---

## 10. Context Service

File: `src/ai/tools/ai-context.service.ts`

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  resolveCompanyTypes, resolveActiveRole, isProducerMembership, hasType,
} from '../ai.utils';
import { buildSyntheticUser } from '../../common/build-synthetic-user';

@Injectable()
export class AiContextService {
  private readonly logger = new Logger(AiContextService.name);

  constructor(private prisma: PrismaService) {}

  // ======================== FREIGHT RESOLUTION ========================

  async resolveFreightWithAccess(code: string, user: any): Promise<{ freight?: any; error?: string }> {
    if (!code || typeof code !== 'string') {
      return { error: 'Código de flete requerido.' };
    }

    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).filter((m: any) => m.active).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);

    let freight: any = await this.findFreightByCode(code.toUpperCase());

    if (!freight) {
      const sanitized = code.replace(/[^a-zA-Z0-9.\-]/g, '').toUpperCase();
      if (sanitized.length >= 3) {
        const candidates = await this.findFreightsByCodePattern(sanitized, allUserCompanies, user.id);
        if (candidates.length === 1) {
          freight = candidates[0];
        } else if (candidates.length > 1) {
          const codes = candidates.map((c: any) => c.code).join(', ');
          return { error: `Se encontraron varios fletes que coinciden con "${code}": ${codes}. Indique el código completo.` };
        }
      }
    }

    const ACCESS_DENIED = `No se encontró el flete ${code} o no tiene acceso.`;
    if (!freight) return { error: ACCESS_DENIED };

    const freightCompanies = [
      freight.originCompanyId, freight.destCompanyId,
      ...(freight.assignments || []).map((a: any) => a.transportCompanyId),
    ].filter(Boolean);
    const isDriver = (freight.assignments || []).some((a: any) => a.driverId === user.id);
    const isCompanyUser = allUserCompanies.some((c: string) => freightCompanies.includes(c));
    if (!isDriver && !isCompanyUser) {
      return { error: ACCESS_DENIED };
    }
    if (isDriver && !isCompanyUser) {
      freight.assignments = (freight.assignments || []).filter((a: any) => a.driverId === user.id);
    }
    return { freight };
  }

  async findFreightByCode(code: string) {
    return this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, tripNumber: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
    });
  }

  async findFreightsByCodePattern(pattern: string, userCompanyIds: string[], userId: string) {
    return this.prisma.freight.findMany({
      where: {
        code: { contains: pattern, mode: 'insensitive' },
        OR: [
          { originCompanyId: { in: userCompanyIds } },
          { destCompanyId: { in: userCompanyIds } },
          { assignments: { some: { transportCompanyId: { in: userCompanyIds } } } },
          { assignments: { some: { driverId: userId } } },
        ],
      },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, tripNumber: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
      take: 5,
    });
  }

  async resolveAssignment(code: string, assignmentId: string | undefined, user: any, session?: any): Promise<{ freight?: any; assignment?: any; error?: string }> {
    const accessResult = await this.resolveFreightWithAccess(code, user);
    if (accessResult.error) return { error: accessResult.error };
    const freight = accessResult.freight;

    if (!freight.isMultiTruck) {
      return { error: 'Para fletes single-truck, usar el endpoint correspondiente.' };
    }

    const activeAssignments = (freight.assignments || []).filter(
      (a: any) => ['active', 'accepted'].includes(a.tripStatus || a.status),
    );

    if (assignmentId) {
      const assignment = activeAssignments.find((a: any) => a.id === assignmentId);
      if (!assignment) return { error: 'Asignación no encontrada o no activa.' };
      return { freight, assignment };
    }

    if (activeAssignments.length === 0) return { error: 'No hay asignaciones activas.' };
    if (activeAssignments.length === 1) return { freight, assignment: activeAssignments[0] };

    return { error: `Hay ${activeAssignments.length} viajes activos. Indicá cuál (usá assignmentId).` };
  }

  // ======================== COMPANY / ROLE RESOLUTION ========================

  resolveCompanyType(user: any): string {
    const activeCoId = user.activeCompanyId || user.companyId;

    if (activeCoId && user.memberships?.length > 0) {
      const activeMem = user.memberships.find((m: any) => m.companyId === activeCoId);
      if (activeMem?.company) {
        const types = resolveCompanyTypes(activeMem.company);
        if (types.length > 0) return types.join(', ');
      }
    }

    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    if (userTypes.length > 0) return userTypes.join(', ');

    if (user.company) {
      const types = resolveCompanyTypes(user.company);
      if (types.length > 0) return types.join(', ');
    }

    if (user.memberships?.length > 0) {
      for (const m of user.memberships) {
        const types = resolveCompanyTypes(m.company);
        if (types.length > 0) return types.join(', ');
      }
    }
    return 'unknown';
  }

  resolveProducerCompanyIdForCompany(user: any, targetCompanyId: string): string | null {
    if (user.memberships?.length > 0) {
      const targetMem = user.memberships.find((m: any) => m.companyId === targetCompanyId && isProducerMembership(m));
      if (targetMem) return targetMem.companyId;
    }
    return this.resolveProducerCompanyId(user);
  }

  resolveProducerCompanyId(user: any): string | null {
    if (user.memberships?.length > 0) {
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isProducerMembership(m));
        if (activeMem) return activeMem.companyId;
      }
      const pm = user.memberships.find(isProducerMembership);
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('producer') && companyByType.producer) return companyByType.producer;
    if (resolveCompanyTypes(user.company).includes('producer')) return user.companyId;
    return null;
  }

  resolvePlantCompanyId(user: any): string | null {
    const isPlant = (m: any) =>
      m.company?.type === 'plant' ||
      (Array.isArray(m.company?.types) && m.company.types.includes('plant'));

    if (user.memberships?.length > 0) {
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isPlant(m));
        if (activeMem) return activeMem.companyId;
      }
      const pm = user.memberships.find(isPlant);
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('plant') && companyByType.plant) return companyByType.plant;
    if (resolveCompanyTypes(user.company).includes('plant')) return user.companyId;
    return null;
  }

  isCallerAdminForCompany(user: any, companyId?: string): boolean {
    if (user.isSuperAdmin || user.role === 'platform_admin') return true;
    if (!companyId) {
      const memberRoles = (user.memberships || []).filter((m: any) => m.active !== false).map((m: any) => m.role);
      return [user.role || '', ...memberRoles].some((r: string) => ['admin', 'gerente', 'platform_admin'].includes(r));
    }
    const membership = (user.memberships || []).find((m: any) => m.companyId === companyId && m.active);
    if (!membership) return false;
    return ['admin', 'gerente'].includes(membership.role);
  }

  canAccessCompany(user: any, synUser: any, companyId: string): boolean {
    const ids = [synUser.companyId, ...(user.memberships || []).filter((m: any) => m.active !== false).map((m: any) => m.companyId)].filter(Boolean);
    return ids.includes(companyId);
  }

  buildSyntheticUser(dbUser: any): any {
    return buildSyntheticUser(dbUser);
  }
}
```

---

## 11. AI Constants

File: `src/ai/ai.constants.ts`

```typescript
export const MAX_HISTORY = 25;
export const MAX_TOOL_LOOPS = 5;
export const AI_SESSION_TIMEOUT_MIN = 30;
export const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';
export const OWN_FLEET_SHORTCUT = 'own_fleet';

export const MODEL_ID = 'claude-sonnet-4-6';
export const MODEL_ID_FAST = 'claude-haiku-4-5-20251001';
export const MODEL_TEMPERATURE = 0.4;
export const MODEL_MAX_TOKENS = 1200;
export const MAX_RESPONSE_CHARS = 3000;
export const STALE_SESSION_MIN = 10;
export const URUGUAY_UTC_OFFSET_MS = -3 * 60 * 60 * 1000;

export const FREIGHT_STATUS_LABELS: Record<string, string> = {
  pending_assignment: 'Pend. asignación', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'En viaje', loaded: 'Cargado', finished: 'Completado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};
export const FREIGHT_STATUS_SHORT: Record<string, string> = {
  pending_assignment: 'Pend. asig.', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'En viaje', loaded: 'Cargado', finished: 'Completado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};

export const AUDIO_FILLERS = /\b(eh+|ehmm*|emm*|mmm*|a+h+|o sea|digamos|viste)\b[,.]?\s*/gi;

export const AI_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const AI_RATE_LIMIT_MAX = 20;
```

---

## 12. AI Utils

File: `src/ai/ai.utils.ts`

```typescript
import { buildSyntheticUser } from '../common/build-synthetic-user';

export function resolveCompanyTypes(company: any): string[] {
  if (!company) return [];
  if (Array.isArray(company.types) && company.types.length > 0) return company.types;
  return company.type ? [company.type] : [];
}

export function resolveActiveRole(user: any): { isChofer: boolean; isAdmin: boolean; userRole: string } {
  const activeCoId = user.activeCompanyId || user.companyId;

  let activeRole: string | null = null;
  if (activeCoId && user.memberships?.length > 0) {
    const activeMem = (user.memberships as any[]).find(
      (m: any) => m.companyId === activeCoId && m.active !== false,
    );
    if (activeMem?.role) activeRole = activeMem.role;
  }

  const effectiveRole = activeRole || user.role || 'operario';

  if (user.role === 'platform_admin') {
    return { isChofer: false, isAdmin: true, userRole: 'admin' };
  }

  const isChofer = effectiveRole === 'chofer';
  const isAdmin = ['admin', 'gerente'].includes(effectiveRole);
  const userRole = isChofer ? 'chofer'
    : isAdmin ? (effectiveRole === 'gerente' ? 'gerente' : 'admin')
    : 'operario';

  return { isChofer, isAdmin, userRole };
}

export function isProducerMembership(m: any): boolean {
  return m.company?.type === 'producer' ||
    (Array.isArray(m.company?.types) && m.company.types.includes('producer'));
}

export function hasType(companyType: string, type: string): boolean {
  return companyType === type || companyType.split(',').some(t => t.trim() === type);
}

export function sanitizeForPrompt(s: string): string {
  return s
    .replace(/[\r\n\x00-\x1F]/g, ' ')
    .replace(/[\[\]{}]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 100);
}

export function aiBuildSyntheticUser(dbUser: any): any {
  return buildSyntheticUser(dbUser);
}
```

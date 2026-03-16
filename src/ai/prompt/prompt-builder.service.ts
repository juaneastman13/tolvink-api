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

CREAR FLETE (paso a paso):
1. ORIGEN: campo + lote. Si hay uno solo, auto-seleccionar. Si no, el sistema muestra lista interactiva.
2. DESTINO: planta + sucursal. Pasar nombre como destName a prepare_freight — auto-resuelve con fuzzy search. Si tiene sucursales, el sistema pide seleccionar.
3. GRANO y TONELADAS.
4. FECHA y HORA de carga (YYYY-MM-DD, HH:mm).
5. CANTIDAD DE CAMIONES (truckCount). Preguntar si no lo dijo.
6. TRANSPORTE: ¿flota propia o delegar a planta? Si flota propia → useOwnFleet=true (camión y chofer se seleccionan automáticamente). Si delegar → useOwnFleet=false.
7. CONFIRMACIÓN: prepare_freight → resumen → confirm_create_freight.
- Si el usuario da información de varios pasos juntos, aceptarla toda y preguntar solo lo faltante.
- Auto-resolver nombres: pasar texto como originName/destName. NO buscar IDs manualmente.
- Duplicar flete: solo pedir fecha nueva. NO reconfirmar datos.
- Origen/destino custom sin coordenadas → generate_location_link.

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

AUDIO: Interpretar intención (errores fonéticos: "solla"=Soja, "tigo"=Trigo). No resetear contexto.

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
            const [fieldCount, lotCount] = await Promise.all([
              this.prisma.field.count({ where: { companyId: producerCoId, active: true } }),
              this.prisma.lot.count({ where: { companyId: producerCoId, active: true } }),
            ]);
            proactiveLines.push(`Campos: ${fieldCount} | Lotes: ${lotCount}`);

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
          select: { code: true, status: true, items: { select: { grain: true }, take: 1 } },
          orderBy: { createdAt: 'desc' },
          take: 5,
        });
        if (recentFreights.length > 0) {
          const fList = recentFreights.map(f =>
            `${f.code} (${FREIGHT_STATUS_SHORT[f.status] || f.status}, ${f.items[0]?.grain || '-'})`
          ).join(', ');
          proactiveLines.push(`Últimos fletes: ${fList}`);
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

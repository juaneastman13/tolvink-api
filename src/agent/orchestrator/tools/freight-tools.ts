import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../../database/prisma.service';
import { FreightsService } from '../../../freights/freights.service';
import { CreateFreightDto } from '../../../freights/freights.dto';
import { UserContext } from '../../tools/context/user-context.service';
import { DraftStore } from '../draft-store.service';

const logger = new Logger('FreightTools');

export interface ToolContext {
  phone: string;
  userCtx: UserContext | null;
  prisma: PrismaService;
  freights: FreightsService;
  drafts: DraftStore;
}

export interface ToolInterception {
  kind: 'buttons';
  text: string;
  buttons: Array<{ id: string; title: string }>;
}

export type ToolResult =
  | { ok: true; data: any; intercept?: ToolInterception }
  | { ok: false; error: string };

export interface ToolDef {
  schema: Anthropic.Messages.Tool;
  handler: (input: any, ctx: ToolContext) => Promise<ToolResult>;
}

// ---------- Tool: list_user_companies ----------
const listUserCompanies: ToolDef = {
  schema: {
    name: 'list_user_companies',
    description: 'Lista las empresas activas del usuario. Usar al inicio si el usuario tiene múltiples empresas y no especifica cuál usar.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  async handler(_input, ctx) {
    if (!ctx.userCtx) return { ok: false, error: 'Usuario no identificado' };
    const result = await ctx.prisma.user.findUnique({
      where: { id: ctx.userCtx.userId },
      select: {
        memberships: {
          where: { active: true },
          select: { companyId: true, company: { select: { name: true, type: true } } },
        },
      },
    });
    const companies = (result?.memberships ?? []).map((m: any) => ({
      id: m.companyId,
      name: m.company?.name ?? '(sin nombre)',
      type: m.company?.type ?? '',
    }));
    return { ok: true, data: { companies } };
  },
};

// ---------- Tool: list_user_fields ----------
const listUserFields: ToolDef = {
  schema: {
    name: 'list_user_fields',
    description: 'Lista los campos guardados de una empresa para sugerir como origen de un flete.',
    input_schema: {
      type: 'object',
      properties: {
        companyId: { type: 'string', description: 'UUID de la empresa' },
      },
      required: ['companyId'],
    },
  },
  async handler(input, ctx) {
    const companyId = String(input?.companyId || '');
    if (!companyId) return { ok: false, error: 'companyId requerido' };
    const fields = await ctx.prisma.field.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true },
      take: 10,
    });
    return { ok: true, data: { fields } };
  },
};

// ---------- Tool: prepare_freight ----------
const prepareFreight: ToolDef = {
  schema: {
    name: 'prepare_freight',
    description:
      'Prepara un flete para confirmación. Valida los datos, persiste un draft con TTL de 15 min, y devuelve un resumen. NO crea el flete todavía — el sistema mostrará automáticamente botones [Confirmar][Cancelar] al usuario. SOLO llamar cuando tengas TODOS los datos obligatorios.',
    input_schema: {
      type: 'object',
      properties: {
        companyId: { type: 'string', description: 'UUID de la empresa que crea el flete (obligatorio)' },
        grain: { type: 'string', description: 'Producto / carga (ej: soja, maíz, trigo) — obligatorio' },
        truckCount: { type: 'integer', description: 'Cantidad de camiones — obligatorio', minimum: 1, maximum: 50 },
        loadDate: { type: 'string', description: 'Fecha de carga en formato YYYY-MM-DD — obligatorio' },
        loadTime: { type: 'string', description: 'Hora de carga en formato HH:MM 24h — obligatorio' },
        destName: { type: 'string', description: 'Nombre del destino (planta, puerto, lugar) — obligatorio' },
        tons: { type: 'number', description: 'Toneladas — opcional', minimum: 0.1 },
        originFieldId: { type: 'string', description: 'UUID del campo de origen si el usuario eligió uno guardado' },
        originLat: { type: 'number', description: 'Latitud GPS de origen si el usuario compartió ubicación' },
        originLng: { type: 'number', description: 'Longitud GPS de origen si el usuario compartió ubicación' },
        originName: { type: 'string', description: 'Nombre descriptivo del origen (ej: "Campo Norte" o "Ubicación compartida")' },
      },
      required: ['companyId', 'grain', 'truckCount', 'loadDate', 'loadTime', 'destName'],
    },
  },
  async handler(input, ctx) {
    if (!ctx.userCtx) return { ok: false, error: 'Usuario no identificado' };

    // Validate origin: must have either field or GPS
    const hasField = !!input.originFieldId;
    const hasGps = input.originLat !== undefined && input.originLng !== undefined;
    if (!hasField && !hasGps) {
      return { ok: false, error: 'Falta origen: necesitás originFieldId, o bien originLat+originLng' };
    }

    const slots = {
      companyId: String(input.companyId),
      grain: String(input.grain),
      truckCount: Number(input.truckCount),
      loadDate: String(input.loadDate),
      loadTime: String(input.loadTime),
      destName: String(input.destName),
      tons: input.tons !== undefined ? Number(input.tons) : undefined,
      originFieldId: input.originFieldId ? String(input.originFieldId) : undefined,
      originLat: input.originLat !== undefined ? Number(input.originLat) : undefined,
      originLng: input.originLng !== undefined ? Number(input.originLng) : undefined,
      originName: input.originName ? String(input.originName) : undefined,
    };

    const draft = ctx.drafts.create(ctx.phone, slots);
    const summary = buildSummary(slots);

    return {
      ok: true,
      data: { status: 'pending_confirmation', draftId: draft.draftId, summary },
      intercept: {
        kind: 'buttons',
        text: summary,
        buttons: [
          { id: `confirm:${draft.draftId}`, title: '✅ Confirmar' },
          { id: `cancel:${draft.draftId}`, title: '❌ Cancelar' },
        ],
      },
    };
  },
};

// ---------- Tool: confirm_freight ----------
const confirmFreight: ToolDef = {
  schema: {
    name: 'confirm_freight',
    description: 'Confirma y crea efectivamente un flete previamente preparado con prepare_freight.',
    input_schema: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: 'ID del draft devuelto por prepare_freight' },
      },
      required: ['draftId'],
    },
  },
  async handler(input, ctx) {
    return executeConfirm(String(input?.draftId || ''), ctx);
  },
};

/** Shared executor — also used by the button shortcut in the orchestrator. */
export async function executeConfirm(draftId: string, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userCtx) return { ok: false, error: 'Usuario no identificado' };
  const draft = draftId ? ctx.drafts.get(draftId) : ctx.drafts.findLatestByPhone(ctx.phone);
  if (!draft) return { ok: false, error: 'No encontré el flete pendiente (puede haber expirado). Empezá de nuevo.' };

  const s = draft.slots;
  const dto: CreateFreightDto = {
    loadDate: s.loadDate,
    loadTime: s.loadTime,
    items: [{ grain: s.grain, ...(s.tons ? { tons: s.tons } : {}), unit: 'toneladas' }],
    ...(s.truckCount ? { truckCount: s.truckCount } : {}),
  } as CreateFreightDto;

  if (s.originFieldId) {
    (dto as any).fieldId = s.originFieldId;
  } else if (s.originLat !== undefined && s.originLng !== undefined) {
    (dto as any).overrideOriginLat = s.originLat;
    (dto as any).overrideOriginLng = s.originLng;
    if (s.originName) (dto as any).customOriginName = s.originName;
  }
  (dto as any).customDestName = s.destName;

  const syntheticUser = {
    sub: ctx.userCtx.userId,
    companyId: s.companyId,
    companyType: ctx.userCtx.companyType,
    role: 'operator',
    companyTypes: [ctx.userCtx.companyType],
  };

  try {
    const freight = await ctx.freights.create(dto, syntheticUser as any);
    ctx.drafts.delete(draft.draftId);
    logger.log(`Freight created via tool use: ${freight.code}`);
    return { ok: true, data: { code: freight.code, status: 'created' } };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`confirm_freight failed: ${msg}`);
    return { ok: false, error: `No pude crear el flete: ${msg}` };
  }
}

/** Shared executor — also used by the cancel button shortcut. */
export function executeCancel(draftId: string, ctx: ToolContext): ToolResult {
  const draft = draftId ? ctx.drafts.get(draftId) : ctx.drafts.findLatestByPhone(ctx.phone);
  if (draft) ctx.drafts.delete(draft.draftId);
  return { ok: true, data: { status: 'cancelled' } };
}

function buildSummary(s: Record<string, any>): string {
  const lines: string[] = ['Resumen del flete:'];
  lines.push(`📦 ${s.grain}${s.tons ? ` — ${s.tons} tn` : ''}`);
  lines.push(`🚚 ${s.truckCount} ${s.truckCount === 1 ? 'camión' : 'camiones'}`);
  lines.push(`📅 ${s.loadDate} ${s.loadTime}`);
  if (s.originName) lines.push(`📍 Desde: ${s.originName}`);
  else if (s.originFieldId) lines.push(`📍 Desde: campo guardado`);
  else if (s.originLat !== undefined) lines.push(`📍 Desde: ubicación compartida`);
  lines.push(`🏭 Hasta: ${s.destName}`);
  lines.push('');
  lines.push('¿Confirmamos?');
  return lines.join('\n');
}

export const FREIGHT_TOOLS: ToolDef[] = [
  listUserCompanies,
  listUserFields,
  prepareFreight,
  confirmFreight,
];

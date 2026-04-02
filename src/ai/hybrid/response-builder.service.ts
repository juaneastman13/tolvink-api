// =====================================================================
// TOLVINK — Response Builder Service
// Formats deterministic responses for WhatsApp (no LLM)
// Mirrors the style the AI agent would produce
// =====================================================================

import { Injectable } from '@nestjs/common';

const STATUS_EMOJI: Record<string, string> = {
  pending_assignment: '⏳', assigned: '📋', accepted: '✅',
  in_progress: '🚛', loaded: '📦', finished: '🏁',
  canceled: '❌', rejected: '🚫',
};
const STATUS_LABELS: Record<string, string> = {
  pending_assignment: 'Sin asignar', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'A campo', loaded: 'A planta', finished: 'Finalizado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};

export interface HybridResponse {
  text: string;
  buttons?: Array<{ id: string; title: string }>;
}

@Injectable()
export class ResponseBuilderService {

  /** Format dashboard data into WhatsApp message */
  formatDashboard(data: any): HybridResponse {
    const lines: string[] = ['📊 *Resumen de actividad*\n'];

    if (data.byStatus?.length) {
      for (const s of data.byStatus) {
        // s.status is the translated label (e.g. "Asignado") — reverse-lookup the key
        const statusKey = Object.entries(STATUS_LABELS).find(([, v]) => v === s.status)?.[0];
        const emoji = STATUS_EMOJI[statusKey || ''] || '•';
        lines.push(`${emoji} ${s.status}: *${s.count}*`);
      }
    }

    if (data.activeFreights !== undefined) {
      lines.push(`\n📦 Fletes activos: *${data.activeFreights}*`);
    }

    if (data.month) {
      lines.push(`\n📅 *${data.month.name}*`);
      lines.push(`• Total: ${data.month.totalFreights} fletes`);
      lines.push(`• Toneladas: ${data.month.totalTons} tn`);
      lines.push(`• Finalizados: ${data.month.completed}`);
      if (data.month.canceled > 0) lines.push(`• Cancelados: ${data.month.canceled}`);
    }

    return { text: lines.join('\n') };
  }

  /** Format freight list into WhatsApp message */
  formatFreightList(freights: any[], total: number, filter?: string): HybridResponse {
    if (!freights || freights.length === 0) {
      return { text: filter ? `No se encontraron fletes con filtro: ${filter}.` : 'No tenés fletes activos.' };
    }

    const lines: string[] = [`📋 *Fletes${filter ? ` (${filter})` : ''}* — ${total} resultado(s)\n`];

    for (const f of freights.slice(0, 10)) {
      const emoji = STATUS_EMOJI[f.status] || '•';
      const status = STATUS_LABELS[f.status] || f.status;
      const grain = f.grain || f.items?.[0]?.grain || '';
      const tons = f.tons || f.items?.reduce((s: number, i: any) => s + (Number(i.tons) || 0), 0) || '';
      lines.push(`${emoji} *${f.code}* — ${grain} ${tons}tn — _${status}_`);
    }

    if (total > 10) {
      lines.push(`\n_...y ${total - 10} más. Usá la app web para ver todos._`);
    }

    return { text: lines.join('\n') };
  }

  /** Format freight detail */
  formatFreightDetail(freight: any): HybridResponse {
    const emoji = STATUS_EMOJI[freight.status] || '📄';
    const status = STATUS_LABELS[freight.status] || freight.status;
    const lines: string[] = [
      `${emoji} *Flete ${freight.code}*\n`,
      `📊 Estado: *${status}*`,
    ];

    if (freight.grain || freight.items?.[0]?.grain) {
      lines.push(`🌾 Grano: ${freight.grain || freight.items[0].grain}`);
    }
    if (freight.tons || freight.items?.[0]?.tons) {
      lines.push(`⚖️ Toneladas: ${freight.tons || freight.items[0].tons}`);
    }
    if (freight.originName) lines.push(`📍 Origen: ${freight.originName}`);
    if (freight.destName) lines.push(`🏭 Destino: ${freight.destName}`);
    if (freight.loadDate) {
      const d = new Date(freight.loadDate);
      lines.push(`📅 Fecha: ${d.toLocaleDateString('es-UY')}`);
    }
    if (freight.assignments?.length) {
      lines.push(`\n🚛 *Camiones (${freight.assignments.length}):*`);
      for (const a of freight.assignments.slice(0, 5)) {
        const plate = a.truck?.plate || 'Sin camión';
        const driver = a.driver?.name || a.truck?.assignedUser?.name || '';
        const tripStatus = a.tripStatus || a.status || '';
        lines.push(`  • ${plate}${driver ? ` (${driver})` : ''} — ${tripStatus}`);
      }
    }

    // Add action buttons based on status
    const buttons: Array<{ id: string; title: string }> = [];
    // Common actions will be added by the router based on user role

    return { text: lines.join('\n'), buttons: buttons.length > 0 ? buttons : undefined };
  }

  /** Format fleet summary */
  formatFleetSummary(data: any): HybridResponse {
    if (data.message) return { text: data.message };

    const lines: string[] = ['🚛 *Resumen de flota*\n'];
    if (data.totalTrucks !== undefined) lines.push(`• Camiones: ${data.totalTrucks}`);
    if (data.income !== undefined) lines.push(`• Ingresos mes: $${data.income.toLocaleString()}`);
    if (data.expense !== undefined) lines.push(`• Gastos mes: $${data.expense.toLocaleString()}`);
    if (data.net !== undefined) lines.push(`• Balance: $${data.net.toLocaleString()}`);
    if (data.expiredDocs > 0) lines.push(`\n⚠️ ${data.expiredDocs} documento(s) vencido(s)`);

    return { text: lines.join('\n') };
  }

  /** Format truck list */
  formatTruckList(trucks: any[]): HybridResponse {
    if (!trucks?.length) return { text: 'No tenés camiones registrados.' };

    const lines: string[] = [`🚛 *Camiones (${trucks.length})*\n`];
    for (const t of trucks.slice(0, 15)) {
      const driver = t.assignedUser?.name || t.driver || 'Sin chofer';
      lines.push(`• *${(t.plate || '').toUpperCase()}* ${t.model || ''} — ${driver}`);
    }

    return { text: lines.join('\n') };
  }

  /** Format driver list */
  formatDriverList(drivers: any[]): HybridResponse {
    if (!drivers?.length) return { text: 'No tenés choferes registrados.' };

    const lines: string[] = [`👤 *Choferes (${drivers.length})*\n`];
    for (const d of drivers.slice(0, 15)) {
      const name = d.user?.name || d.name || 'Sin nombre';
      const phone = d.user?.phone || d.phone || '';
      lines.push(`• *${name}*${phone ? ` — ${phone}` : ''}`);
    }

    return { text: lines.join('\n') };
  }

  /** Generic error message */
  formatError(message: string): HybridResponse {
    return { text: `⚠️ ${message}` };
  }

  /** Greeting / main menu */
  formatGreeting(userName: string, companyType: string): HybridResponse {
    const name = userName?.split(' ')[0] || 'usuario';
    const lines: string[] = [
      `👋 ¡Hola ${name}!`,
      '',
      '¿Qué necesitás?',
      '',
      '📊 *Dashboard* — Ver resumen',
      '📋 *Mis fletes* — Ver fletes activos',
    ];

    if (companyType.includes('producer')) {
      lines.push('🆕 *Crear flete* — Nuevo envío');
    }
    if (companyType.includes('transporter')) {
      lines.push('🚛 *Mis camiones* — Ver flota');
    }

    lines.push('\nO escribí tu consulta libremente.');

    return { text: lines.join('\n') };
  }

  /** Help message */
  formatHelp(): HybridResponse {
    return {
      text: [
        '❓ *Ayuda — Tolvink*\n',
        'Podés escribirme en lenguaje natural:',
        '',
        '📊 "dashboard" — Resumen de actividad',
        '📋 "mis fletes" — Listar fletes',
        '🔍 "F26-XXX.1234" — Ver detalle de flete',
        '🆕 "crear flete" — Nuevo flete',
        '🆕 "mandá 30 tn de soja a Planta X" — Crear directo',
        '🚛 "mis camiones" — Ver flota',
        '',
        'También podés enviar fotos, documentos y ubicaciones.',
      ].join('\n'),
    };
  }

  /** Profile info */
  formatProfile(user: any): HybridResponse {
    const lines: string[] = ['👤 *Mi perfil*\n'];
    if (user.name) lines.push(`Nombre: ${user.name}`);
    if (user.email) lines.push(`Email: ${user.email}`);
    if (user.phone) lines.push(`Teléfono: ${user.phone}`);

    const company = user.memberships?.find((m: any) => m.companyId === user.activeCompanyId)?.company;
    if (company) {
      lines.push(`\n🏢 *Empresa:* ${company.name}`);
      if (company.type) lines.push(`Tipo: ${company.type}`);
    }

    return { text: lines.join('\n') };
  }

  /** Confirm action response */
  formatConfirmResult(result: string): HybridResponse {
    try {
      const data = JSON.parse(result);
      if (data.error) return this.formatError(data.error);
      if (data.message) return { text: `✅ ${data.message}` };
      return { text: '✅ Acción confirmada.' };
    } catch {
      return { text: result };
    }
  }

  /** Cancel action response */
  formatCancelResult(): HybridResponse {
    return { text: '❌ Acción cancelada.' };
  }
}

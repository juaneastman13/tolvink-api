import { AgentLocation } from '../schemas/agent-state.schema';
import { CreateFreightSlots } from '../schemas/freight.schema';
import { FreightListItem } from '../tools/freight.tools';

export class WhatsAppAgentV2Renderer {
  greeting(): string {
    return 'Tolvink\nDecime que operacion de flete queres resolver.';
  }

  help(): string {
    return [
      'Puedo ayudarte con fletes por WhatsApp.',
      'Por ahora en V2: crear una solicitud de flete paso a paso.',
    ].join('\n');
  }

  askMissingSlot(slot: string): string {
    const questions: Record<string, string> = {
      product: 'Que producto queres transportar?',
      origin: 'Desde donde sale la carga?',
      destination: 'A que destino va?',
      date: 'Para que fecha queres la carga?',
      time: 'A que hora queres la carga?',
      truckCount: 'Cuantos camiones necesitas?',
    };
    return questions[slot] || 'Me falta un dato para continuar.';
  }

  askOriginLocation(): string {
    return 'Enviame la ubicacion exacta del origen usando el boton de ubicacion de WhatsApp.';
  }

  askDestinationLocation(): string {
    return 'Ahora enviame la ubicacion exacta del destino usando el boton de ubicacion de WhatsApp.';
  }

  locationReceived(type: 'origin' | 'destination' | 'interest_point'): string {
    const label = type === 'destination' ? 'destino' : type === 'interest_point' ? 'punto de interes' : 'origen';
    return `Ubicacion de ${label} recibida.`;
  }

  unexpectedLocation(): string {
    return 'Recibi una ubicacion. Decime si queres usarla para un origen, destino o punto de interes.';
  }

  createFreightConfirmation(
    slots: CreateFreightSlots,
    locations?: { originLocation?: AgentLocation | null; destinationLocation?: AgentLocation | null },
  ): string {
    return [
      'Te resumo la solicitud:',
      '',
      `Producto: ${slots.product}`,
      `Camiones: ${slots.truckCount}`,
      `Origen: ${slots.origin}`,
      `Ubicacion origen: ${locations?.originLocation ? 'recibida' : 'pendiente'}`,
      `Destino: ${slots.destination}`,
      `Ubicacion destino: ${locations?.destinationLocation ? 'recibida' : 'pendiente'}`,
      `Fecha: ${slots.date}`,
      `Hora: ${slots.time}`,
      slots.observations ? `Observaciones: ${slots.observations}` : null,
      '',
      'Confirmas crear la solicitud?',
    ].filter(Boolean).join('\n');
  }

  created(code: string): string {
    return ['Solicitud creada', `Codigo: ${code}`].join('\n');
  }

  prepared(code: string): string {
    return ['Pre-solicitud preparada', `Referencia: ${code}`, 'La creacion real esta desactivada para beta.'].join('\n');
  }

  noFreightsFound(): string {
    return 'No encontre fletes para ese criterio.';
  }

  freightList(items: FreightListItem[]): string {
    if (items.length === 0) return this.noFreightsFound();
    const rows = items.slice(0, 10).map((item, idx) => {
      const route = `${item.origin || '-'} -> ${item.destination || '-'}`;
      const date = [item.date, item.time].filter(Boolean).join(' ');
      return `${idx + 1}. ${item.code} - ${item.product || 'Carga'} - ${route} - ${date || 'sin fecha'} - ${formatStatus(item.status)}`;
    });
    if (items.length > 10) rows.push('Mostre los primeros 10. Podes pedirme un filtro mas especifico.');
    return rows.join('\n');
  }

  freightDetail(item: FreightListItem): string {
    return [
      `${item.code} - ${formatStatus(item.status)}`,
      '',
      `Carga: ${item.product || '-'}${item.tons ? ` ${item.tons} tn` : ''}`,
      `Origen: ${item.origin || '-'}`,
      `Destino: ${item.destination || '-'}`,
      `Fecha: ${[item.date, item.time].filter(Boolean).join(' ') || '-'}`,
      `Transporte: ${item.transportCompany || 'sin asignar'}`,
      item.driver || item.truck ? `Chofer/camion: ${[item.driver, item.truck].filter(Boolean).join(' - ')}` : null,
    ].filter(Boolean).join('\n');
  }

  blockedMissingLocation(): string {
    return 'No puedo crear el flete real sin ubicacion exacta de origen y destino.';
  }

  canceled(): string {
    return 'Listo, cancele la solicitud.';
  }

  unsupported(): string {
    return 'Todavia no tengo ese flujo activo en Agent V2. Puedo ayudarte a crear una solicitud de flete.';
  }

  error(message?: string): string {
    return message || 'No pude procesar el mensaje. Proba de nuevo.';
  }
}

function formatStatus(status: string): string {
  const labels: Record<string, string> = {
    draft: 'Borrador',
    pending_assignment: 'Pendiente',
    assigned: 'Asignado',
    accepted: 'Aceptado',
    in_progress: 'A campo',
    loaded: 'A planta',
    arrived: 'Llegado',
    finished: 'Finalizado',
    canceled: 'Cancelado',
  };
  return labels[status] || status;
}

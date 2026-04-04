// =====================================================================
// TOLVINK — Context injection for user messages
// Injects active freight, pending documents, locations, etc.
// =====================================================================

import { Injectable } from '@nestjs/common';
import { sanitizeForPrompt } from '../utils/ai-utils';
import { STALE_SESSION_MIN } from '../core/constants';

@Injectable()
export class ContextBuilderService {
  private isNewFreightRequest(message: string): boolean {
    const m = (message || '').toLowerCase();
    // Explicit create intent + typical freight payload hints.
    const hasCreateVerb = /\b(manda|mandá|mandá|mandar|envia|enviar|crear?\s+flete|nuevo\s+flete)\b/i.test(m);
    const hasFreightHints = /\b(tonelad|soja|maiz|trigo|girasol|sorgo|cebada|camion|camiones|planta|lote|campo|manana|mañana|hoy|fecha)\b/i.test(m);
    return hasCreateVerb && hasFreightHints;
  }

  /** Enrich user message with session context injections. */
  buildContextualMessage(
    cleanedMessage: string,
    state: any,
    aiMessagesCount: number,
  ): string {
    let messageToSend = cleanedMessage;
    const newFreightRequest = this.isNewFreightRequest(cleanedMessage);

    // Stale session detection
    const lastMsgTime = state.lastMessageAt ? new Date(state.lastMessageAt).getTime() : 0;
    if (lastMsgTime && aiMessagesCount > 0) {
      const minutesGap = (Date.now() - lastMsgTime) / 60000;
      if (minutesGap > STALE_SESSION_MIN) {
        messageToSend = `[Sistema: pasaron ${Math.round(minutesGap)} min desde el ultimo mensaje. El usuario puede estar retomando o cambiando de tema.]\n\n${cleanedMessage}`;
      }
    }

    // Pending document: compact injection
    if (state.pendingDocument) {
      const doc = state.pendingDocument;
      const safeName = (doc.name || '').replace(/[^\w\s.\-()aeiounAEIOUN]/g, '').slice(0, 60);
      const activeCode = state.activeContext?.lastFreightCode;
      messageToSend = `[ARCHIVO: "${safeName}" (${doc.type}, URL: ${doc.url}).${activeCode ? ` Flete activo: ${sanitizeForPrompt(activeCode)}.` : ''} Adjuntar con attach_document(code) o attach_truck_document(plate,linkTo,linkId).]\n\n${messageToSend}`;
    }

    // Inject lastLocation
    if (state.lastLocation) {
      const loc = state.lastLocation;
      messageToSend = `[UBICACION: lat=${loc.lat}, lng=${loc.lng}${loc.name ? `, "${sanitizeForPrompt(loc.name)}"` : ''}. Usar en prepare_freight customDest/customOrigin.]\n\n${messageToSend}`;
    }

    // Inject active context
    if (state.activeContext && !state.pendingDocument) {
      const ac = state.activeContext;
      if (ac.lastFreightCode) {
        if (!newFreightRequest) {
          messageToSend = `[FLETE ACTIVO: ${sanitizeForPrompt(ac.lastFreightCode)}. Resumen: ${sanitizeForPrompt(ac.lastFreightSummary || '')}. Ultima accion: ${sanitizeForPrompt(ac.lastAction || 'ninguna')}.]\n\n${messageToSend}`;
        } else {
          messageToSend = `[Sistema: el usuario inicio un NUEVO pedido de flete. No arrastrar filtros ni acciones previas, y priorizar prepare_freight.]\n\n${messageToSend}`;
        }
      } else if (ac.lastSearchFilter) {
        if (!newFreightRequest) {
          messageToSend = `[Contexto: filtro=${sanitizeForPrompt(ac.lastSearchFilter)}]\n\n${messageToSend}`;
        } else {
          messageToSend = `[Sistema: ignorar filtro previo de busqueda (${sanitizeForPrompt(ac.lastSearchFilter)}) porque el usuario inicio un NUEVO pedido de flete.]\n\n${messageToSend}`;
        }
      }
    }

    // Recovered context from expired session
    if (state._sessionExpiredNote && state._recoveredContext) {
      const rc = state._recoveredContext;
      const parts: string[] = [];
      if (rc.lastFreightCode) parts.push(`ultimo flete: ${sanitizeForPrompt(rc.lastFreightCode)}`);
      if (rc.lastAction) parts.push(`ultima accion: ${sanitizeForPrompt(rc.lastAction)}`);
      if (rc.lastSearchFilter) parts.push(`ultimo filtro: ${sanitizeForPrompt(rc.lastSearchFilter)}`);
      if (parts.length > 0) {
        messageToSend = `[Sistema: la sesion anterior expiro. Contexto recuperado: ${parts.join('. ')}. Informar brevemente al usuario que su sesion anterior expiro y ofrecerse a retomar.]\n\n${messageToSend}`;
      }
    }

    // Inject pending action context (skip when creating freight to avoid stale-action interference)
    if (state.pendingAction && !state.pendingFreight && !newFreightRequest) {
      const pa = state.pendingAction;
      messageToSend = `[Sistema: hay una accion pendiente de confirmacion: ${sanitizeForPrompt(pa.summary || pa.tool || '')}. Si el usuario confirma -> confirm_action. Si cancela o cambia de tema -> ignorar la accion pendiente.]\n\n${messageToSend}`;
    }

    return messageToSend;
  }
}

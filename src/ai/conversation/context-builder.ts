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

  private isDestructiveFreightIntent(message: string): boolean {
    const m = (message || '').toLowerCase();
    return /\b(cancela|cancelar|cancelalo|cancelalo|anula|anular|elimina|borrar|adjunta|adjuntar|archivo|documento|foto|finaliza|finalizar|termina|terminar)\b/i.test(m);
  }

  /** Enrich user message with session context injections. */
  buildContextualMessage(
    cleanedMessage: string,
    state: any,
    aiMessagesCount: number,
  ): string {
    let messageToSend = cleanedMessage;
    const newFreightRequest = this.isNewFreightRequest(cleanedMessage);
    const destructiveIntent = this.isDestructiveFreightIntent(cleanedMessage);

    // Inject awaiting answer from previous turn — MUST be first CTX so it frames the user's reply
    if (state.awaitingAnswer) {
      const aa = state.awaitingAnswer;
      const age = aa.setAt ? Math.round((Date.now() - aa.setAt) / 60000) : 0;
      if (age < 10) {
        const intentHint = aa.expectedIntent
          ? ` expectedIntent="${sanitizeForPrompt(aa.expectedIntent)}"`
          : '';
        messageToSend = `[CTX_AWAITING_ANSWER question="${sanitizeForPrompt(aa.question)}"${intentHint}]\n\n${messageToSend}`;
      }
    }

    // Stale session detection
    const lastMsgTime = state.lastMessageAt ? new Date(state.lastMessageAt).getTime() : 0;
    if (lastMsgTime && aiMessagesCount > 0) {
      const minutesGap = (Date.now() - lastMsgTime) / 60000;
      if (minutesGap > STALE_SESSION_MIN) {
        messageToSend = `[CTX_SESSION_GAP minutes=${Math.round(minutesGap)}]\n\n${cleanedMessage}`;
      }
    }

    // Pending document: compact injection
    if (state.pendingDocument) {
      const doc = state.pendingDocument;
      const safeName = (doc.name || '').replace(/[^\w\s.\-()aeiounAEIOUN]/g, '').slice(0, 60);
      const activeCode = state.activeContext?.lastFreightCode;
      messageToSend = `[CTX_DOCUMENT name="${safeName}" type="${sanitizeForPrompt(doc.type || '')}" url="${sanitizeForPrompt(doc.url || '')}"${activeCode ? ` activeFreight="${sanitizeForPrompt(activeCode)}"` : ''}]\n\n${messageToSend}`;
    }

    // Inject lastLocation
    if (state.lastLocation) {
      const loc = state.lastLocation;
      messageToSend = `[CTX_LOCATION lat=${loc.lat} lng=${loc.lng}${loc.name ? ` name="${sanitizeForPrompt(loc.name)}"` : ''}]\n\n${messageToSend}`;
    }

    // Inject active context
    if (state.activeContext && !state.pendingDocument) {
      const ac = state.activeContext;
      if (ac.lastFreightCode) {
        if (!newFreightRequest) {
          if (!destructiveIntent) {
            messageToSend = `[CTX_ACTIVE_FREIGHT code="${sanitizeForPrompt(ac.lastFreightCode)}" summary="${sanitizeForPrompt(ac.lastFreightSummary || '')}" lastAction="${sanitizeForPrompt(ac.lastAction || 'ninguna')}"]\n\n${messageToSend}`;
          } else {
            messageToSend = `[CTX_REQUIRE_EXPLICIT_FREIGHT codeHint="${sanitizeForPrompt(ac.lastFreightCode)}"]\n\n${messageToSend}`;
          }
        } else {
          messageToSend = `[CTX_NEW_FREIGHT_REQUEST]\n\n${messageToSend}`;
        }
      } else if (ac.lastSearchFilter) {
        if (!newFreightRequest) {
          messageToSend = `[CTX_LAST_FILTER value="${sanitizeForPrompt(ac.lastSearchFilter)}"]\n\n${messageToSend}`;
        } else {
          messageToSend = `[CTX_CLEAR_FILTER previous="${sanitizeForPrompt(ac.lastSearchFilter)}"]\n\n${messageToSend}`;
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
        messageToSend = `[CTX_RECOVERED_SESSION ${parts.join('. ')}]\n\n${messageToSend}`;
      }
    }

    // Inject pending action context (skip when creating freight to avoid stale-action interference)
    if (state.pendingAction && !state.pendingFreight && !newFreightRequest) {
      const pa = state.pendingAction;
      messageToSend = `[CTX_PENDING_ACTION id="${sanitizeForPrompt(pa.actionId || '')}" summary="${sanitizeForPrompt(pa.summary || pa.tool || '')}"]\n\n${messageToSend}`;
    }

    return messageToSend;
  }
}

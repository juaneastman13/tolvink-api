// =====================================================================
// TOLVINK — Session side-effects, action staging, pending selections
// Ported from backup session-manager.service.ts
// =====================================================================

import { Injectable } from '@nestjs/common';
import { MAX_HISTORY_MESSAGES } from '../core/constants';
import { randomUUID } from 'crypto';

@Injectable()
export class SessionManagerService {
  private _chatSideEffects: Map<string, Record<string, any>> = new Map();

  getChatSideEffectsMap(): Map<string, Record<string, any>> {
    return this._chatSideEffects;
  }

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
      if (v._ts && now - v._ts > 3 * 60 * 1000) this._chatSideEffects.delete(k);
      else if (!v._ts) this._chatSideEffects.delete(k);
    }
    if (this._chatSideEffects.size > 1_000) {
      const iter = this._chatSideEffects.keys();
      while (this._chatSideEffects.size > 500) {
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
    customButtons?: { confirm?: string; cancel?: string },
  ): string {
    const effects = this._chatSideEffects.get(sessionId) || {};
    const stagedCompanyId = user?.activeCompanyId || user?.companyId || params?.actionSynUser?.companyId || null;
    const actionId = randomUUID().slice(0, 8);
    effects.pendingAction = { actionId, tool, params, summary, createdAt: Date.now(), stagedCompanyId };
    effects._pendingButtons = [
      { id: `ai_confirm:${actionId}`, title: customButtons?.confirm || 'CONFIRMAR' },
      { id: `ai_cancel:${actionId}`, title: customButtons?.cancel || 'CANCELAR' },
    ];
    effects._ts = effects._ts || Date.now();
    this._chatSideEffects.set(sessionId, effects);

    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      IMPORTANT: 'La accion NO fue ejecutada todavia. Presente el resumen y consulte al usuario si confirma. Se enviaran botones CONFIRMAR/CANCELAR automaticamente.',
    });
  }
}

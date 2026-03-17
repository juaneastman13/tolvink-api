import { Injectable } from '@nestjs/common';
import { MAX_HISTORY } from '../ai.constants';

/**
 * Manages AI session side-effects, history trimming, action staging,
 * and pending selection state.
 *
 * Side-effects are accumulated during tool execution within a single chat() call,
 * then merged into the session write at the end. This avoids DB race conditions
 * from multiple tool calls writing to the same session.
 */
@Injectable()
export class SessionManagerService {
  private _chatSideEffects: Map<string, Record<string, any>> = new Map();

  /** Get the underlying side-effects map (for direct access by AiService) */
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

  /** Clean stale side effects (>10 min old) + hard cap at 5k entries */
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

  /** Accumulate active context update — merged by chat() into single session write */
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

  /** Store interactive list selection in side-effects (merged by chat()) */
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

  /** Stage an action for user confirmation — accumulates in side-effects (merged by chat()) */
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

  /** Trim message history intelligently: keep recent + preserve tool results */
  smartTrimHistory(messages: any[]): any[] {
    if (messages.length <= MAX_HISTORY) return messages;

    let trimmed = messages.slice(-MAX_HISTORY);

    // Ensure we don't start with an orphaned tool_result
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

    // Ensure we don't end with a tool_use without its tool_result
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

    // Guardrail: if trimming removed everything, keep at least the last user message
    if (trimmed.length === 0 && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && (!Array.isArray(m.content) || !m.content.some((b: any) => b.type === 'tool_result')));
      if (lastUserMsg) return [lastUserMsg];
      return messages.slice(-1);
    }

    return trimmed;
  }
}

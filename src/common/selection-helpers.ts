// =====================================================================
// TOLVINK — Selection Helpers (shared interfaces + resolve logic)
// Used by WhatsAppService, WhatsAppFlowService, WhatsAppRouterService
// =====================================================================

import { fuzzySearch, classifyFuzzyResult } from './fuzzy-match';

export interface SelectionItem {
  id: string;
  title: string;
  description?: string;
}

export interface SelectionConfig {
  headerText: string;
  listButtonLabel?: string;   // default: 'Ver opciones'
  sectionTitle?: string;      // default: 'Opciones'
  pageSize?: number;          // default: 20, max 20
  page?: number;              // 1-based, default: 1
  footer?: SelectionItem;     // extra item at the end (e.g., "OTRO ORIGEN")
}

export interface SelectionResult {
  mode: 'list' | 'numbered_text';
  shownItems: SelectionItem[];
  page: number;
  totalPages: number;
  totalItems: number;
}

export interface SelectionContext {
  items: SelectionItem[];
  shownItems: SelectionItem[];
  page: number;
  totalPages: number;
  pageSize: number;
  footer?: SelectionItem;
  purpose: string;
  config: SelectionConfig;
}

/**
 * Resolve a user's text reply against a stored SelectionContext.
 * Returns the matched item, a pagination command, or null.
 */
export function resolveSelectionReply(
  text: string,
  ctx: SelectionContext,
): SelectionItem | 'next_page' | 'prev_page' | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  // Pagination commands
  if (/^(mas|más|siguiente|next|ver mas|ver más)$/i.test(t)) {
    return ctx.page < ctx.totalPages ? 'next_page' : null;
  }
  if (/^(anterior|prev|atras|atrás)$/i.test(t)) {
    return ctx.page > 1 ? 'prev_page' : null;
  }

  // "0" maps to footer
  if (t === '0' && ctx.footer) return ctx.footer;

  // Numeric reply (1-based global index)
  const num = parseInt(t, 10);
  if (!isNaN(num) && num >= 1 && num <= ctx.items.length) {
    return ctx.items[num - 1];
  }

  // Exact name match (case-insensitive) against shown items
  const byName = ctx.shownItems.find(
    (item) => item.title.toLowerCase() === t,
  );
  if (byName) return byName;

  // Partial name match (starts with)
  const byPartial = ctx.shownItems.find(
    (item) => item.title.toLowerCase().startsWith(t),
  );
  if (byPartial) return byPartial;

  // Fuzzy name match (audio transcription tolerance)
  const fuzzyResults = fuzzySearch(t, ctx.shownItems, (item) => item.title);
  const classification = classifyFuzzyResult(fuzzyResults);
  if (classification === 'exact' || classification === 'confident') {
    return fuzzyResults[0].item;
  }

  return null;
}

// =====================================================================
// TOLVINK — Message pre/post-processing
// =====================================================================

import { MAX_RESPONSE_CHARS, WEB_MAX_RESPONSE_CHARS, AUDIO_FILLERS } from '../core/constants';

/** Clean audio transcription: strip filler words, normalize whitespace. */
export function preprocessMessage(text: string): string {
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

/** Post-process AI response: strip UUIDs, enforce length, quality check. */
export function validateResponse(text: string, isWeb = false): string {
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  let clean = text.replace(UUID_RE, (match, offset) => {
    const before = text.slice(Math.max(0, offset - 80), offset);
    if (/https?:\/\/\S*$/i.test(before)) return match;
    return '[ID interno]';
  });

  const maxChars = isWeb ? WEB_MAX_RESPONSE_CHARS : MAX_RESPONSE_CHARS;
  if (clean.length > maxChars && !/F\d{2}-[A-Z]{3}\.\d{4}|FLT-\d{4,}/i.test(clean)) {
    const lineBreak = clean.lastIndexOf('\n', maxChars);
    if (lineBreak > maxChars * 0.5) {
      clean = clean.slice(0, lineBreak);
    } else {
      const sentenceBreak = clean.lastIndexOf('. ', maxChars);
      if (sentenceBreak > maxChars * 0.5) {
        clean = clean.slice(0, sentenceBreak + 1);
      } else {
        clean = clean.slice(0, maxChars);
      }
    }
  }

  return clean.replace(/\n{3,}/g, '\n\n').trim();
}

/** Button type for WhatsApp reply buttons. */
interface Button { id: string; title: string; }

const CONFIRMATION_PATTERNS: Array<{ pattern: RegExp; buttons: Button[] }> = [
  { pattern: /crear?\s*(el\s*)?flete/i, buttons: [{ id: 'confirm', title: '✅ Crear flete' }, { id: 'edit', title: '✏️ Cambiar' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /cancelar?\s*(el\s*)?flete/i, buttons: [{ id: 'confirm', title: '✅ Cancelar flete' }, { id: 'cancel', title: '❌ No cancelar' }] },
  { pattern: /asignar?/i, buttons: [{ id: 'confirm', title: '✅ Asignar' }, { id: 'edit', title: '✏️ Cambiar' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /aceptar?\s*(el\s*)?flete/i, buttons: [{ id: 'confirm', title: '✅ Aceptar' }, { id: 'cancel', title: '❌ Rechazar' }] },
  { pattern: /iniciar?\s*(el\s*)?viaje/i, buttons: [{ id: 'confirm', title: '✅ Iniciar' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /confirmar?\s*(la\s*)?carga/i, buttons: [{ id: 'confirm', title: '✅ Confirmar' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /confirmar?\s*(la\s*)?entrega/i, buttons: [{ id: 'confirm', title: '✅ Confirmar' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /crear?\s*(el\s*)?campo/i, buttons: [{ id: 'confirm', title: '✅ Crear campo' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /crear?\s*(el\s*)?lote/i, buttons: [{ id: 'confirm', title: '✅ Crear lote' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /crear?\s*(el\s*)?usuario/i, buttons: [{ id: 'confirm', title: '✅ Crear usuario' }, { id: 'cancel', title: '❌ Cancelar' }] },
  { pattern: /registrar?/i, buttons: [{ id: 'confirm', title: '✅ Registrar' }, { id: 'cancel', title: '❌ Cancelar' }] },
];

/** Ensure confirmation buttons are present when the response text implies a confirmation action. */
export function ensureConfirmationButtons(text: string, existingButtons?: Button[]): Button[] {
  if (existingButtons && existingButtons.length > 0) return existingButtons;
  for (const { pattern, buttons } of CONFIRMATION_PATTERNS) {
    if (pattern.test(text)) return buttons;
  }
  return [];
}

/** Normalize spoken numbers to digits. */
export function normalizeSpokenNumbers(text: string): string {
  const map: Record<string, string> = {
    cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4',
    cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9', diez: '10',
    once: '11', doce: '12', trece: '13', catorce: '14', quince: '15',
    veinte: '20', veintiuno: '21', treinta: '30', cuarenta: '40',
    cincuenta: '50', sesenta: '60', setenta: '70', ochenta: '80', noventa: '90',
    cien: '100', doscientos: '200', trescientos: '300', quinientos: '500', mil: '1000',
  };
  let result = text;
  for (const [word, num] of Object.entries(map)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), num);
  }
  return result;
}

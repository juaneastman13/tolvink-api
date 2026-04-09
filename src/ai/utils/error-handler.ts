// =====================================================================
// TOLVINK — AI error handling utilities
// =====================================================================

/** Known safe error patterns — pass through to user. */
const SAFE_PATTERNS: RegExp[] = [
  /no (se )?encontr/i, /no tiene acceso/i, /no se puede/i, /solo.*pueden/i,
  /no.*permiso/i, /ya existe/i, /no pertenec/i, /flete.*no/i, /campo.*no/i,
  /lote.*no/i, /camion.*no/i, /codigo.*requerido/i, /invalid/i,
  /no.*asignaci/i, /no.*disponible/i, /no.*registrad/i, /estado.*no permite/i,
  /debe.*primero/i, /falta.*obligatori/i, /ya.*esta/i, /no.*existe/i,
  /planta.*no/i, /productor.*no/i, /transportista.*no/i, /chofer.*no/i,
  /documento.*no/i, /sesion.*no/i, /empresa.*no/i,
  /bloqueado/i, /cancelad/i, /finalizad/i, /vencid/i,
];

/** Map known error patterns to user-friendly messages for confirm_action dispatch. */
const CONFIRM_SAFE_ERRORS: [RegExp, string][] = [
  [/no encontrad/i, 'El recurso no fue encontrado.'],
  [/no se puede cancelar/i, ''],  // pass through
  [/estado.*inv[aá]lido|transici[oó]n/i, 'La operacion no es valida en el estado actual del flete.'],
  [/ya.*asignad|ya.*acept/i, 'La accion ya fue realizada previamente.'],
  [/permiso|forbidden|autoriza/i, 'No tiene permisos para realizar esta accion.'],
  [/chofer no encontrado/i, 'El chofer indicado no fue encontrado en la empresa.'],
  [/empresa.*no.*encontr/i, 'La empresa indicada no fue encontrada.'],
  [/membres[ií]a/i, 'El usuario ya no pertenece a la empresa.'],
  [/ya ten[eé]s un flete activo/i, ''],  // pass through — message is already user-friendly
  [/flete activo/i, ''],  // pass through
  [/finalizalo o cancelalo/i, ''],  // pass through
  [/solo se puede/i, ''],  // pass through state validation errors
  [/estado actual/i, ''],  // pass through
  [/no es autonomo/i, 'Este flete no es autonomo.'],
  [/no sos el chofer/i, 'No sos el chofer de este flete.'],
  [/ya se registr/i, ''],  // pass through (e.g. "ya se registró la llegada")
  [/Los choferes no pueden/i, ''],  // pass through
];

/** Determine if an error message is safe to show to the user. */
export function isSafeError(msg: string): boolean {
  return SAFE_PATTERNS.some(p => p.test(msg));
}

/** Sanitize error for tool result — safe errors pass through, others get generic message. */
export function sanitizeToolError(err: Error): string {
  const msg = String(err.message || '');
  const safe = isSafeError(msg);
  return JSON.stringify({ error: safe ? msg : 'Error al procesar la solicitud.' });
}

/** Sanitize confirm_action dispatch error — returns user-friendly message. */
export function sanitizeConfirmError(err: Error): string {
  const msg = String(err.message || '');
  for (const [re, replacement] of CONFIRM_SAFE_ERRORS) {
    if (re.test(msg)) {
      return replacement || msg;
    }
  }
  return 'No se pudo ejecutar la accion. Intente nuevamente.';
}

/** Redact sensitive fragments before logging external/provider errors. */
export function sanitizeErrorForLog(input: unknown): string {
  let msg = String(input ?? '');
  // Google API key pattern + explicit api_key fields.
  msg = msg.replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_API_KEY]');
  msg = msg.replace(/(api[_-]?key['"\s:=]+)([^\s'",}]+)/gi, '$1[REDACTED]');
  // Common auth/token leaks.
  msg = msg.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, '$1[REDACTED]');
  msg = msg.replace(/("?(?:access|refresh|id)?_?token"?\s*[:=]\s*"?)([^"\s,}]+)/gi, '$1[REDACTED]');
  msg = msg.replace(/(authorization["'\s:=]+)([^\s'",}]+)/gi, '$1[REDACTED]');
  return msg;
}

/** Coarse error categorization for logs/observability and user fallback paths. */
export function classifyAiError(errLike: unknown): 'provider_suspended' | 'provider_unavailable' | 'rate_limited' | 'forbidden' | 'timeout' | 'unknown' {
  const msg = String((errLike as any)?.message || errLike || '').toLowerCase();
  if (msg.includes('consumer_suspended') || msg.includes('has been suspended')) return 'provider_suspended';
  if (msg.includes('unavailable') || msg.includes('high demand') || msg.includes('503')) return 'provider_unavailable';
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) return 'rate_limited';
  if (msg.includes('permission_denied') || msg.includes('forbidden') || msg.includes('403')) return 'forbidden';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  return 'unknown';
}

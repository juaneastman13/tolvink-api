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

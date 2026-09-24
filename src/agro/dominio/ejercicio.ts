/**
 * Ejercicio fiscal configurable.
 *
 * Un único parámetro `mesInicioEjercicio` (1..12) define el corte anual.
 * Ej: `mesInicioEjercicio = 7` ⇒ ejercicios julio–junio.
 *     `mesInicioEjercicio = 1` ⇒ ejercicios calendario.
 *
 * Además se puede definir un **corte intermedio** (mes+día, típicamente 30/06
 * para conciliar contra la declaración DICOSE) que no cambia el ejercicio,
 * pero sí genera un cierre de stock a esa fecha.
 *
 * Convenciones:
 *   - Un ejercicio se identifica por el **año calendario en que termina**
 *     (usanza contable UY). Con inicio en enero, 2025 = 01/01/2025 → 31/12/2025.
 *     Con inicio en julio, 2025 = 01/07/2024 → 30/06/2025.
 *   - Los cálculos son sobre fechas naïve (sin zona horaria); asumimos UTC.
 *
 * Capa pura: sin dependencias de Nest/Prisma. Cero side effects.
 */

export interface EjercicioConfig {
  /** 1..12; mes en que inicia el ejercicio. */
  mesInicioEjercicio: number;
  /** Mes del corte intermedio (opcional). */
  cierreIntermedioMes?: number | null;
  /** Día del corte intermedio (opcional). */
  cierreIntermedioDia?: number | null;
}

export interface RangoFechas {
  desde: Date;
  hasta: Date; // inclusivo (último día del ejercicio a las 23:59:59.999)
}

/**
 * Valida y normaliza la configuración.
 */
export function validarConfig(cfg: EjercicioConfig): EjercicioConfig {
  const m = cfg.mesInicioEjercicio;
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new RangeError(`mesInicioEjercicio inválido: ${m}`);
  }
  const cm = cfg.cierreIntermedioMes ?? null;
  const cd = cfg.cierreIntermedioDia ?? null;
  if ((cm === null) !== (cd === null)) {
    throw new RangeError(
      'cierreIntermedioMes y cierreIntermedioDia deben venir juntos o vacíos',
    );
  }
  if (cm !== null && (cm < 1 || cm > 12)) {
    throw new RangeError(`cierreIntermedioMes inválido: ${cm}`);
  }
  if (cd !== null && (cd < 1 || cd > 31)) {
    throw new RangeError(`cierreIntermedioDia inválido: ${cd}`);
  }
  return { mesInicioEjercicio: m, cierreIntermedioMes: cm, cierreIntermedioDia: cd };
}

/**
 * Devuelve el número de ejercicio (año calendario de finalización) al que
 * pertenece una fecha dada.
 */
export function ejercicioDe(cfg: EjercicioConfig, fecha: Date): number {
  const { mesInicioEjercicio: m } = validarConfig(cfg);
  const y = fecha.getUTCFullYear();
  const mes = fecha.getUTCMonth() + 1; // 1..12
  if (m === 1) return y; // ejercicios calendario
  // Si estamos antes del mes de inicio, seguimos en el ejercicio que "cierra este año".
  // Si estamos en o después del mes de inicio, ya empezamos el ejercicio que cerrará el año siguiente.
  return mes < m ? y : y + 1;
}

/**
 * Rango [desde, hasta] del ejercicio identificado por su año de cierre.
 */
export function rangoDeEjercicio(
  cfg: EjercicioConfig,
  ejercicio: number,
): RangoFechas {
  const { mesInicioEjercicio: m } = validarConfig(cfg);
  if (m === 1) {
    return {
      desde: new Date(Date.UTC(ejercicio, 0, 1, 0, 0, 0, 0)),
      hasta: new Date(Date.UTC(ejercicio, 11, 31, 23, 59, 59, 999)),
    };
  }
  // Ejercicio X: inicia el 1/m del año (X-1), termina último día de (m-1) del año X.
  const desde = new Date(Date.UTC(ejercicio - 1, m - 1, 1, 0, 0, 0, 0));
  // Último día del mes anterior al mes de inicio, del año X.
  // Ejemplo: m=7 → termina 30/06/X. Usamos día 0 del mes m-1 (index m-1) del año X
  // = último día del mes m-1 = último día de junio.
  const hasta = new Date(Date.UTC(ejercicio, m - 1, 0, 23, 59, 59, 999));
  return { desde, hasta };
}

/**
 * Rango cerrado del ejercicio al que pertenece `fecha`.
 */
export function rangoEjercicioDe(
  cfg: EjercicioConfig,
  fecha: Date,
): RangoFechas & { ejercicio: number } {
  const ej = ejercicioDe(cfg, fecha);
  const r = rangoDeEjercicio(cfg, ej);
  return { ...r, ejercicio: ej };
}

/**
 * Fecha del corte intermedio para un ejercicio dado, si está configurado.
 * Devuelve null si no aplica o si el mes+día no cae dentro del ejercicio.
 */
export function fechaCorteIntermedio(
  cfg: EjercicioConfig,
  ejercicio: number,
): Date | null {
  const { cierreIntermedioMes, cierreIntermedioDia } = validarConfig(cfg);
  if (cierreIntermedioMes === null || cierreIntermedioDia === null) return null;
  const { desde, hasta } = rangoDeEjercicio(cfg, ejercicio);
  // Probamos en el año de inicio y en el de fin; usamos el que caiga dentro del rango.
  const candidatos = [
    new Date(
      Date.UTC(desde.getUTCFullYear(), cierreIntermedioMes - 1, cierreIntermedioDia),
    ),
    new Date(
      Date.UTC(hasta.getUTCFullYear(), cierreIntermedioMes - 1, cierreIntermedioDia),
    ),
  ];
  for (const c of candidatos) {
    if (c >= desde && c <= hasta) return c;
  }
  return null;
}

/**
 * Nombre humano del ejercicio: "2025" si calendario, "2024/25" si julio–junio.
 */
export function nombreEjercicio(
  cfg: EjercicioConfig,
  ejercicio: number,
): string {
  const { mesInicioEjercicio: m } = validarConfig(cfg);
  if (m === 1) return String(ejercicio);
  const start = ejercicio - 1;
  const endShort = String(ejercicio).slice(-2);
  return `${start}/${endShort}`;
}

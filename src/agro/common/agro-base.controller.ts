import { AgroScopeService } from './agro-scope.service';

/**
 * Utilidades comunes que necesitan los controllers agro para resolver la
 * empresa activa desde una request. No es una clase base porque los
 * controllers ya heredan implícitamente de sus @Controller — es sólo un
 * helper que se llama con inyección explícita del `AgroScopeService`.
 */
export async function empresaIdOf(
  scope: AgroScopeService,
  user: any,
  req: any,
): Promise<string> {
  const { empresaId } = await scope.resolveEmpresa(
    user,
    scope.extractExplicitId(req),
  );
  return empresaId;
}

/** Parsea 'YYYY-MM-DD' o ISO a Date UTC 00:00 (dominio agro trabaja en fechas naïve). */
export function parseFecha(s: string | undefined | null): Date | null {
  if (!s) return null;
  const d = new Date(s.length === 10 ? s + 'T00:00:00Z' : s);
  return isNaN(d.getTime()) ? null : d;
}

export function requireFecha(s: string): Date {
  const d = parseFecha(s);
  if (!d) throw new Error(`Fecha inválida: ${s}`);
  return d;
}

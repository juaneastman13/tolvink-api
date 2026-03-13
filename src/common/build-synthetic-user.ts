/**
 * Build a synthetic JWT-like user object from a DB user.
 * Shared across AI, Router, and Flow services to avoid duplication.
 */

/** Expected shape of the dbUser parameter */
export interface DbUserForSynthetic {
  id: string;
  role?: string;
  activeCompanyId?: string | null;
  companyId?: string | null;
  userTypes?: string[];
  companyByType?: Record<string, string>;
  company?: { type?: string; types?: string[] } | null;
  memberships?: Array<{
    companyId: string;
    company?: { type?: string; types?: string[] } | null;
  }>;
}

export function buildSyntheticUser(dbUser: DbUserForSynthetic): any {
  if (!dbUser) throw new Error('buildSyntheticUser: dbUser is required');
  const companyByType = (dbUser.companyByType as any) || {};
  const userTypes = Array.isArray(dbUser.userTypes) ? dbUser.userTypes : [];

  let companyId = dbUser.activeCompanyId || dbUser.companyId || '';

  // Resolve company types: prefer types[] array, fallback to single type
  const resolveTypes = (co: any): string[] => {
    if (!co) return [];
    if (Array.isArray(co.types) && co.types.length > 0) return co.types;
    return co.type ? [co.type] : [];
  };

  let resolvedTypes: string[] = [];
  if (userTypes.length > 0) {
    resolvedTypes = userTypes;
  } else if (dbUser.company) {
    resolvedTypes = resolveTypes(dbUser.company);
  }
  if (resolvedTypes.length === 0 && dbUser.memberships?.length > 0) {
    const first = dbUser.memberships[0];
    resolvedTypes = resolveTypes(first.company);
    companyId = companyId || first.companyId;
  }

  const companyType = resolvedTypes[0] || 'unknown';

  return {
    sub: dbUser.id,
    role: dbUser.role || 'operator',
    companyId,
    companyType,
    companyTypes: resolvedTypes.length > 0 ? resolvedTypes : [],
    userType: companyType,
    activeCompanyId: dbUser.activeCompanyId,
  };
}

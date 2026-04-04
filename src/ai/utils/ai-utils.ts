// =====================================================================
// TOLVINK — AI Utility Functions (static / pure)
// =====================================================================

import { buildSyntheticUser } from '../../common/build-synthetic-user';

/** Resolve types[] from a company object. */
export function resolveCompanyTypes(company: any): string[] {
  if (!company) return [];
  if (Array.isArray(company.types) && company.types.length > 0) return company.types;
  return company.type ? [company.type] : [];
}

/** Resolve user role scoped to activeCompanyId. */
export function resolveActiveRole(user: any): { isChofer: boolean; isAdmin: boolean; userRole: string } {
  const activeCoId = user.activeCompanyId || user.companyId;
  let activeRole: string | null = null;
  if (activeCoId && user.memberships?.length > 0) {
    const activeMem = (user.memberships as any[]).find(
      (m: any) => m.companyId === activeCoId && m.active !== false,
    );
    if (activeMem?.role) activeRole = activeMem.role;
  }
  const effectiveRole = activeRole || user.role || 'operario';

  if (user.role === 'platform_admin') {
    const memberRole = activeRole || 'admin';
    const isPlatformChofer = memberRole === 'chofer';
    return {
      isChofer: false,
      isAdmin: true,
      userRole: isPlatformChofer ? 'admin' : (memberRole === 'gerente' ? 'gerente' : 'admin'),
    };
  }

  const isChofer = effectiveRole === 'chofer';
  const isAdmin = ['admin', 'gerente'].includes(effectiveRole);
  const userRole = isChofer ? 'chofer'
    : isAdmin ? (effectiveRole === 'gerente' ? 'gerente' : 'admin')
    : 'operario';

  return { isChofer, isAdmin, userRole };
}

/** Check if membership belongs to a producer company. */
export function isProducerMembership(m: any): boolean {
  return m.company?.type === 'producer' ||
    (Array.isArray(m.company?.types) && m.company.types.includes('producer'));
}

/** Exact match for company type in comma-separated string. */
export function hasType(companyType: string, type: string): boolean {
  return companyType === type || companyType.split(',').some(t => t.trim() === type);
}

/** Strip newlines/control chars/prompt delimiters from user-controlled strings. */
export function sanitizeForPrompt(s: string): string {
  return s
    .replace(/[\r\n\x00-\x1F]/g, ' ')
    .replace(/[\[\]{}]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 100);
}

/** Build a synthetic user object from a full DB user. */
export function aiBuildSyntheticUser(dbUser: any): any {
  return buildSyntheticUser(dbUser);
}

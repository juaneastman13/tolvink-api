// =====================================================================
// TOLVINK — AI Utility Functions (static / pure)
// Shared across prompt builder, tool executor, and context services
// =====================================================================

import { buildSyntheticUser } from '../common/build-synthetic-user';

/**
 * Resolve types[] from a company object: prefer types[] array, fallback to single type field.
 */
export function resolveCompanyTypes(company: any): string[] {
  if (!company) return [];
  if (Array.isArray(company.types) && company.types.length > 0) return company.types;
  return company.type ? [company.type] : [];
}

/**
 * Resolve user role scoped to their activeCompanyId (or companyId fallback).
 * Fixes P0: a user who is chofer in company A and admin in company B
 * should NOT be treated as chofer when operating in company B.
 */
export function resolveActiveRole(user: any): { isChofer: boolean; isAdmin: boolean; userRole: string } {
  const activeCoId = user.activeCompanyId || user.companyId;

  // Find the membership for the active company
  let activeRole: string | null = null;
  if (activeCoId && user.memberships?.length > 0) {
    const activeMem = (user.memberships as any[]).find(
      (m: any) => m.companyId === activeCoId && m.active !== false,
    );
    if (activeMem?.role) activeRole = activeMem.role;
  }

  // Fallback to user.role if no membership found (legacy / single-company)
  const effectiveRole = activeRole || user.role || 'operario';

  // platform_admin: use membership role if available, but always grant admin as minimum
  if (user.role === 'platform_admin') {
    // If they have a membership role in the active company, respect it but ensure admin access
    const memberRole = activeRole || 'admin';
    const isPlatformChofer = memberRole === 'chofer';
    return {
      isChofer: false, // platform_admin is never limited to chofer
      isAdmin: true,   // always has admin tools
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

/** Check if a membership belongs to a producer company. */
export function isProducerMembership(m: any): boolean {
  return m.company?.type === 'producer' ||
    (Array.isArray(m.company?.types) && m.company.types.includes('producer'));
}

/** Exact match for company type in comma-separated string (prevents substring false positives). */
export function hasType(companyType: string, type: string): boolean {
  return companyType === type || companyType.split(',').some(t => t.trim() === type);
}

/** Strip newlines/control chars/prompt delimiters from user-controlled strings interpolated into system prompt. */
export function sanitizeForPrompt(s: string): string {
  return s
    .replace(/[\r\n\x00-\x1F]/g, ' ')
    .replace(/[\[\]{}]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 100);
}

/** Build a synthetic user object from a full DB user (delegates to common utility). */
export function aiBuildSyntheticUser(dbUser: any): any {
  return buildSyntheticUser(dbUser);
}

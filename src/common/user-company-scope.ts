export function getActiveCompanyId(user: any): string | null {
  return user?.activeCompanyId || user?.companyId || null;
}

export function getActiveMembership(user: any): any | null {
  const activeCoId = getActiveCompanyId(user);
  if (!activeCoId || !Array.isArray(user?.memberships)) return null;
  return user.memberships.find((m: any) => m.companyId === activeCoId && m.active !== false) || null;
}

export function getScopedCompany(user: any): any | null {
  return getActiveMembership(user)?.company || user?.company || null;
}

export function getScopedRole(user: any): string | null {
  return getActiveMembership(user)?.role || user?.role || null;
}

export function scopeUserToCompany(user: any, companyId?: string | null): any {
  if (!user || !companyId) return user;
  const membership = Array.isArray(user.memberships)
    ? user.memberships.find((m: any) => m.companyId === companyId && m.active !== false)
    : null;
  if (!membership) return user;
  return {
    ...user,
    activeCompanyId: companyId,
    companyId,
    company: membership.company || user.company,
  };
}

export function scopeUserToSessionCompany(user: any, session?: any): any {
  const selectedCompanyId = (session?.flowState as any)?.selectedCompanyId;
  return scopeUserToCompany(user, selectedCompanyId);
}

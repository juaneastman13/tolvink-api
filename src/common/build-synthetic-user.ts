/**
 * Build a synthetic JWT-like user object from a DB user.
 * Shared across AI, Router, and Flow services to avoid duplication.
 */
export function buildSyntheticUser(dbUser: any): any {
  if (!dbUser) throw new Error('buildSyntheticUser: dbUser is required');
  const companyByType = (dbUser.companyByType as any) || {};
  const userTypes = Array.isArray(dbUser.userTypes) ? dbUser.userTypes : [];

  let companyType = 'unknown';
  let companyId = dbUser.activeCompanyId || dbUser.companyId || '';

  if (userTypes.length > 0) {
    companyType = userTypes[0];
  } else if (dbUser.company?.type) {
    companyType = dbUser.company.type;
  } else if (dbUser.memberships?.length > 0) {
    const first = dbUser.memberships[0];
    const types = Array.isArray(first.company?.types) && first.company.types.length > 0
      ? first.company.types : [first.company?.type];
    companyType = types[0] || 'unknown';
    companyId = companyId || first.companyId;
  }

  return {
    sub: dbUser.id,
    role: dbUser.role || 'operator',
    companyId,
    companyType,
    userType: companyType,
    activeCompanyId: dbUser.activeCompanyId,
  };
}

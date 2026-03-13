// =====================================================================
// TOLVINK — Company Type Helpers
// Unifies the dual type system: `type` (string) + `types` (Json array)
// =====================================================================

/**
 * Extract all types from a company object.
 * Prefers `types[]` array if populated, falls back to singular `type`.
 */
export function getCompanyTypes(company: any): string[] {
  if (!company) return [];
  if (Array.isArray(company.types) && company.types.length > 0) {
    return company.types;
  }
  return company.type ? [company.type] : [];
}

/**
 * Check whether a company has a specific type.
 * Handles both `type` (legacy string) and `types` (Json array).
 */
export function companyHasType(company: any, type: string): boolean {
  if (!company) return false;
  if (company.type === type) return true;
  return Array.isArray(company.types) && company.types.includes(type);
}

/**
 * Check whether a membership's company has a specific type.
 * Shorthand for `companyHasType(membership.company, type)`.
 */
export function membershipHasType(membership: any, type: string): boolean {
  return companyHasType(membership?.company, type);
}

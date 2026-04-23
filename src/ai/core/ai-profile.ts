import { getActiveMembership, getScopedCompany, getScopedRole } from '../../common/user-company-scope';

export type AiProfile =
  | 'producer_manager'
  | 'producer_operator'
  | 'producer_driver'
  | 'transporter_manager'
  | 'transporter_driver'
  | 'plant_manager'
  | 'plant_operator'
  | 'plant_driver'
  | 'autonomous_driver';

function getCompanyType(user: any, membership: any): 'producer' | 'transporter' | 'plant' {
  const rawTypes = membership?.company?.types
    || getScopedCompany(user)?.types
    || (membership?.company?.type ? [membership.company.type] : null)
    || (getScopedCompany(user)?.type ? [getScopedCompany(user).type] : null)
    || [];

  const types = Array.isArray(rawTypes) ? rawTypes : [rawTypes];
  if (types.includes('plant')) return 'plant';
  if (types.includes('transporter')) return 'transporter';
  return 'producer';
}

function normalizeRole(rawRole?: string | null): 'manager' | 'operator' | 'driver' {
  const role = (rawRole || '').toLowerCase().trim();
  if (role === 'chofer' || role === 'driver') return 'driver';
  if (role === 'gerente' || role === 'admin' || role === 'platform_admin') return 'manager';
  return 'operator';
}

export function resolveAiProfile(user: any): AiProfile {
  const activeMem = getActiveMembership(user);
  const companyType = getCompanyType(user, activeMem);
  const role = normalizeRole(getScopedRole(user));
  const autonomousDriverEnabled = !!(
    activeMem?.company?.autonomousDriverEnabled
    || getScopedCompany(user)?.autonomousDriverEnabled
  );

  if (role === 'driver' && autonomousDriverEnabled && companyType === 'producer') {
    return 'autonomous_driver';
  }

  return `${companyType}_${role}` as AiProfile;
}

export function getAiProfileLabel(profile: AiProfile): string {
  switch (profile) {
    case 'producer_manager': return 'Productor gerente';
    case 'producer_operator': return 'Productor operario';
    case 'producer_driver': return 'Productor chofer';
    case 'transporter_manager': return 'Transportista gerente';
    case 'transporter_driver': return 'Transportista chofer';
    case 'plant_manager': return 'Planta gerente';
    case 'plant_operator': return 'Planta operario';
    case 'plant_driver': return 'Planta chofer';
    case 'autonomous_driver': return 'Chofer autonomo';
    default: return 'Usuario operativo';
  }
}

import { resolveAiProfile } from '../ai-profile';

describe('resolveAiProfile', () => {
  it('uses the active membership role instead of the global user role', () => {
    const user = {
      role: 'gerente',
      companyId: 'producer-1',
      activeCompanyId: 'transporter-1',
      company: { type: 'producer' },
      memberships: [
        {
          companyId: 'producer-1',
          active: true,
          role: 'gerente',
          company: { type: 'producer', types: ['producer'] },
        },
        {
          companyId: 'transporter-1',
          active: true,
          role: 'chofer',
          company: { type: 'transporter', types: ['transporter'] },
        },
      ],
    };

    expect(resolveAiProfile(user)).toBe('transporter_driver');
  });

  it('detects autonomous driver from the active company membership only', () => {
    const user = {
      role: 'operario',
      companyId: 'producer-1',
      activeCompanyId: 'producer-2',
      company: { type: 'producer', autonomousDriverEnabled: false },
      memberships: [
        {
          companyId: 'producer-1',
          active: true,
          role: 'gerente',
          company: { type: 'producer', types: ['producer'], autonomousDriverEnabled: false },
        },
        {
          companyId: 'producer-2',
          active: true,
          role: 'chofer',
          company: { type: 'producer', types: ['producer'], autonomousDriverEnabled: true },
        },
      ],
    };

    expect(resolveAiProfile(user)).toBe('autonomous_driver');
  });
});

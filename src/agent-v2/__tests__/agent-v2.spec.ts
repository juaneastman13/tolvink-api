import { AgentV2Service } from '../agent-v2.service';
import { validateSlotsNode } from '../nodes/validate-slots.node';
import { extractQueryFreightsInput } from '../flows/query-freights.flow';
import { extractMapFreightCode } from '../flows/share-map.flow';
import { isGlobalCancelMessage } from '../nodes/cancel-intent';
import { makeCancelPendingActionNode } from '../nodes/cancel-pending-action.node';
import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { checkActionPolicy } from '../policies/action-policy';
import { buildFreightActionButtons } from '../policies/freight-action-buttons';

describe('Agent V2 routing safety', () => {
  const previousMode = process.env.AGENT_MODE;

  afterEach(() => {
    if (previousMode === undefined) delete process.env.AGENT_MODE;
    else process.env.AGENT_MODE = previousMode;
  });

  it('defaults to legacy when AGENT_MODE is not set', () => {
    delete process.env.AGENT_MODE;
    const service = new AgentV2Service({} as any, {} as any, {} as any, {} as any, {} as any);
    expect(service.getMode()).toBe('legacy');
    expect(service.isEnabled()).toBe(false);
  });

  it('uses v2 only when explicitly enabled', () => {
    process.env.AGENT_MODE = 'v2';
    const service = new AgentV2Service({} as any, {} as any, {} as any, {} as any, {} as any);
    expect(service.getMode()).toBe('v2');
    expect(service.isEnabled()).toBe(true);
  });

  it('falls back to legacy for invalid values', () => {
    process.env.AGENT_MODE = 'experimental';
    const service = new AgentV2Service({} as any, {} as any, {} as any, {} as any, {} as any);
    expect(service.getMode()).toBe('legacy');
  });
});

describe('create_freight location gating', () => {
  it('asks origin location after text slots are complete', async () => {
    const result = await validateSlotsNode({
      currentFlow: 'create_freight',
      slots: {
        product: 'soja',
        origin: 'Ombues',
        destination: 'Palmira',
        date: 'manana',
        time: '07:00',
        truckCount: 2,
      },
    } as any);
    expect(result.currentStep).toBe('awaiting_location');
    expect(result.locationRequestType).toBe('origin');
  });

  it('asks destination location after origin location is present', async () => {
    const result = await validateSlotsNode({
      currentFlow: 'create_freight',
      slots: {
        product: 'soja',
        origin: 'Ombues',
        destination: 'Palmira',
        date: 'manana',
        time: '07:00',
        truckCount: 2,
      },
      originLocation: {
        lat: -34,
        lng: -57,
        source: 'whatsapp_location',
        capturedAt: new Date().toISOString(),
        capturedByUserId: 'u1',
      },
    } as any);
    expect(result.currentStep).toBe('awaiting_location');
    expect(result.locationRequestType).toBe('destination');
  });
});

describe('create_freight cancellation', () => {
  it('detects explicit global cancel commands', () => {
    expect(isGlobalCancelMessage('cancelar')).toBe(true);
    expect(isGlobalCancelMessage('salir')).toBe(true);
    expect(isGlobalCancelMessage('7 am')).toBe(false);
    expect(isGlobalCancelMessage('no')).toBe(false);
  });

  it('clears pending create freight state on cancellation', async () => {
    const node = makeCancelPendingActionNode(new WhatsAppAgentV2Renderer());
    const result = await node({
      currentIntent: 'create_freight',
      currentFlow: 'create_freight',
      currentStep: 'awaiting_location',
      awaitingSlot: null,
      slots: { product: 'soja' },
      originLocation: {
        lat: -34,
        lng: -57,
        source: 'whatsapp_location',
        capturedAt: new Date().toISOString(),
        capturedByUserId: 'u1',
      },
      pendingLocationRequest: true,
      locationRequestType: 'destination',
      pendingConfirmation: false,
    } as any);
    expect(result.currentFlow).toBeNull();
    expect(result.currentStep).toBeNull();
    expect(result.slots).toEqual({});
    expect(result.originLocation).toBeNull();
    expect(result.pendingLocationRequest).toBe(false);
    expect(result.response).toContain('cancele');
  });
});

describe('query_freights input extraction', () => {
  it('detects tomorrow list queries', () => {
    expect(extractQueryFreightsInput('viajes para manana')).toMatchObject({
      dateFilter: 'tomorrow',
    });
  });

  it('uses active freight code for contextual detail', () => {
    expect(extractQueryFreightsInput('como va ese viaje', 'F-123')).toMatchObject({
      freightCode: 'F-123',
    });
  });

  it('detects Tolvink freight codes in detail queries', () => {
    expect(extractQueryFreightsInput('detalle F26-BKP.2847')).toMatchObject({
      freightCode: 'F26-BKP.2847',
    });
  });
});

describe('share_map input extraction', () => {
  it('detects explicit freight code for map links', () => {
    expect(extractMapFreightCode('pasame el mapa del flete F-123')).toBe('F-123');
  });

  it('detects Tolvink freight codes for map links', () => {
    expect(extractMapFreightCode('pasame mapa del F26-BKP.2847')).toBe('F26-BKP.2847');
  });

  it('uses active freight context for map links', () => {
    expect(extractMapFreightCode('pasame el mapa de ese viaje', 'F-456')).toBe('F-456');
  });
});

describe('agent-v2 freight action buttons', () => {
  const driverUser = { id: 'driver-1', activeCompanyId: 'transporter-1' };

  it('offers start button to transporter/driver on accepted freight', () => {
    const buttons = buildFreightActionButtons({
      id: 'freight-1',
      status: 'accepted',
      originCompanyId: 'producer-1',
      destCompanyId: 'plant-1',
      assignmentTransportCompanyId: 'transporter-1',
      assignmentDriverId: 'driver-1',
    }, driverUser, 'transporter-1');

    expect(buttons).toEqual([{ id: 'start:freight-1', title: 'INICIAR VIAJE' }]);
  });

  it('offers reception confirmation to destination company on loaded freight', () => {
    const buttons = buildFreightActionButtons({
      id: 'freight-1',
      status: 'loaded',
      originCompanyId: 'producer-1',
      destCompanyId: 'plant-1',
      assignmentTransportCompanyId: 'transporter-1',
      assignmentDriverId: 'driver-1',
      plantFinishedConfirmedAt: null,
    }, { id: 'plant-user', activeCompanyId: 'plant-1' }, 'plant-1');

    expect(buttons).toEqual([{ id: 'confirm_finished:freight-1', title: 'CONFIRMAR RECEPCION' }]);
  });

  it('does not offer operational buttons to unrelated users', () => {
    const buttons = buildFreightActionButtons({
      id: 'freight-1',
      status: 'in_progress',
      originCompanyId: 'producer-1',
      destCompanyId: 'plant-1',
      assignmentTransportCompanyId: 'transporter-1',
      assignmentDriverId: 'driver-1',
    }, { id: 'other', activeCompanyId: 'other-company' }, 'other-company');

    expect(buttons).toEqual([]);
  });
});

describe('agent-v2 policies', () => {
  it('allows create_freight for operator alias with active company', () => {
    const decision = checkActionPolicy({
      activeCompanyId: 'company-1',
      activeCompanyType: 'producer',
      activeRole: 'operator',
      membershipActive: true,
    } as any, 'create_freight');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it('blocks create_freight for inactive memberships', () => {
    const decision = checkActionPolicy({
      activeCompanyId: 'company-1',
      activeCompanyType: 'producer',
      activeRole: 'operator',
      membershipActive: false,
    } as any, 'create_freight');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('membresia');
  });

  it('blocks create_freight without active company', () => {
    const decision = checkActionPolicy({
      activeRole: 'operator',
      membershipActive: true,
    } as any, 'create_freight');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('empresa');
  });
});

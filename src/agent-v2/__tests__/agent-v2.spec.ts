import { AgentV2Service } from '../agent-v2.service';
import { validateSlotsNode } from '../nodes/validate-slots.node';
import { extractQueryFreightsInput } from '../flows/query-freights.flow';

describe('Agent V2 routing safety', () => {
  const previousMode = process.env.AGENT_MODE;

  afterEach(() => {
    if (previousMode === undefined) delete process.env.AGENT_MODE;
    else process.env.AGENT_MODE = previousMode;
  });

  it('defaults to legacy when AGENT_MODE is not set', () => {
    delete process.env.AGENT_MODE;
    const service = new AgentV2Service({} as any, {} as any, {} as any);
    expect(service.getMode()).toBe('legacy');
    expect(service.isEnabled()).toBe(false);
  });

  it('uses v2 only when explicitly enabled', () => {
    process.env.AGENT_MODE = 'v2';
    const service = new AgentV2Service({} as any, {} as any, {} as any);
    expect(service.getMode()).toBe('v2');
    expect(service.isEnabled()).toBe(true);
  });

  it('falls back to legacy for invalid values', () => {
    process.env.AGENT_MODE = 'experimental';
    const service = new AgentV2Service({} as any, {} as any, {} as any);
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
});


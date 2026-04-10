import { GeminiRouterService } from './gemini-router.service';

describe('GeminiRouterService', () => {
  const service = new GeminiRouterService();
  const context: any = {
    channel: 'web',
    phone: 'web',
    user: {},
    session: { flowState: {} },
  };

  it('routes greetings to direct response', async () => {
    const result = await service.decide('hola', context);
    expect(result.mode).toBe('direct_response');
    expect(result.intent).toBe('greeting');
    expect(result.shouldEscalate).toBe(false);
  });

  it('routes freight queries to tools', async () => {
    const result = await service.decide('mis fletes', context);
    expect(result.mode).toBe('openai_tools');
    expect(result.intent).toBe('freight_query');
    expect(result.toolTags).toContain('query');
  });

  it('routes creation requests to tools', async () => {
    const result = await service.decide('crear flete nuevo', context);
    expect(result.mode).toBe('openai_tools');
    expect(result.intent).toBe('freight_create');
    expect(result.toolTags).toContain('create');
    expect(result.shouldEscalate).toBe(true);
  });

  it('routes lifecycle requests to lifecycle tools', async () => {
    const result = await service.decide('ya cargue el flete', context);
    expect(result.mode).toBe('openai_tools');
    expect(result.intent).toBe('freight_update');
    expect(result.toolTags).toContain('lifecycle');
    expect(result.shouldEscalate).toBe(true);
  });

  it('routes pending confirmations without escalation', async () => {
    const result = await service.decide('si', {
      ...context,
      session: { flowState: { pendingAction: { kind: 'executor_confirmation' } } },
    });
    expect(result.intent).toBe('confirm_pending_action');
    expect(result.shouldEscalate).toBe(false);
  });
});

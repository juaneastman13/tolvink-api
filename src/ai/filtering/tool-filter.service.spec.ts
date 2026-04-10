import { ToolFilterService } from './tool-filter.service';
import { AiToolDescriptor, AiRouteDecision } from '../contracts/agent.types';

describe('ToolFilterService', () => {
  const service = new ToolFilterService();
  const catalog: AiToolDescriptor[] = [
    {
      name: 'list_freights',
      description: 'query',
      domain: 'freights',
      tags: ['query'],
      allowedIntents: ['freight_query'],
      write: false,
      strongModelOnly: false,
      risk: 'low',
    },
    {
      name: 'create_freight',
      description: 'create',
      domain: 'freights',
      tags: ['create'],
      allowedIntents: ['freight_create'],
      requiredCompanyTypes: ['producer', 'plant'],
      write: true,
      strongModelOnly: true,
      risk: 'high',
    },
    {
      name: 'confirm_loaded',
      description: 'lifecycle',
      domain: 'freights',
      tags: ['lifecycle'],
      allowedIntents: ['freight_update'],
      requiredEntityKeys: ['freightRef'],
      write: true,
      strongModelOnly: true,
      risk: 'high',
    },
  ];

  it('keeps only query tools for query route', () => {
    const route: AiRouteDecision = {
      mode: 'openai_tools',
      intent: 'freight_query',
      risk: 'medium',
      toolTags: ['query'],
      toolDomains: ['freights'],
      reason: 'test',
    };

    const result = service.filter(route, {
      channel: 'web',
      phone: 'web',
      user: { company: { type: 'producer' } },
      session: { flowState: {} },
    }, catalog);

    expect(result.map((item) => item.name)).toEqual(['list_freights']);
  });

  it('blocks create tool when company type is not allowed', () => {
    const route: AiRouteDecision = {
      mode: 'openai_tools',
      intent: 'freight_create',
      risk: 'high',
      toolTags: ['create'],
      toolDomains: ['freights'],
      reason: 'test',
    };

    const result = service.filter(route, {
      channel: 'web',
      phone: 'web',
      user: { company: { type: 'transporter' } },
      session: { flowState: {} },
    }, catalog);

    expect(result).toHaveLength(0);
  });

  it('keeps lifecycle tool for update route', () => {
    const route: AiRouteDecision = {
      mode: 'openai_tools',
      intent: 'freight_update',
      risk: 'high',
      toolTags: ['lifecycle', 'query'],
      toolDomains: ['freights'],
      entityHints: { freightRef: 'F26-123' },
      reason: 'test',
    };

    const result = service.filter(route, {
      channel: 'web',
      phone: 'web',
      user: { company: { type: 'transporter' } },
      session: { flowState: {} },
    }, catalog);

    expect(result.map((item) => item.name)).toContain('confirm_loaded');
  });

  it('blocks lifecycle tool when freight entity is missing', () => {
    const route: AiRouteDecision = {
      mode: 'openai_tools',
      intent: 'freight_update',
      risk: 'high',
      toolTags: ['lifecycle'],
      toolDomains: ['freights'],
      reason: 'test',
    };

    const result = service.filter(route, {
      channel: 'web',
      phone: 'web',
      user: { company: { type: 'transporter' } },
      session: { flowState: {} },
    }, catalog);

    expect(result.map((item) => item.name)).not.toContain('confirm_loaded');
  });
});

import { ContextBuilderService } from './context-builder';

describe('ContextBuilderService', () => {
  const svc = new ContextBuilderService();

  it('injects compact CTX tags instead of imperative system directives', () => {
    const msg = svc.buildContextualMessage(
      'quiero crear un flete',
      {
        pendingAction: { summary: 'cancelar flete F01-ABC.2026' },
      },
      2,
    );
    expect(msg).toContain('CTX_PENDING_ACTION');
    expect(msg).not.toContain('Si el usuario confirma ->');
  });
});


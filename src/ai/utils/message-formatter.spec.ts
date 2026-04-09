import { ensureConfirmationButtons } from './message-formatter';

describe('message-formatter', () => {
  it('generates AI-scoped confirmation button IDs', () => {
    const buttons = ensureConfirmationButtons('Te resumo el flete. ¿Confirmas crear el flete?');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0].id).toBe('ai_confirm');
    expect(buttons.map((b) => b.id)).not.toContain('confirm');
    expect(buttons.map((b) => b.id)).not.toContain('cancel');
  });
});


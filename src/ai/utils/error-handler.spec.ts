import { classifyAiError, sanitizeErrorForLog } from './error-handler';

describe('error-handler', () => {
  it('redacts API keys and bearer tokens in logs', () => {
    const raw = 'Permission denied: api_key:AIzaSyCEV-hOTYu4qhvA-0sq3H1beNN8gOHZBck Authorization=Bearer abc123';
    const clean = sanitizeErrorForLog(raw);
    expect(clean).not.toContain('AIzaSyCEV-hOTYu4qhvA-0sq3H1beNN8gOHZBck');
    expect(clean).not.toContain('abc123');
    expect(clean).toContain('[REDACTED');
  });

  it('classifies provider suspended errors', () => {
    const err = new Error('PERMISSION_DENIED: Consumer has been suspended');
    expect(classifyAiError(err)).toBe('provider_suspended');
  });
});


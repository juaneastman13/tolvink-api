export function extractFreightCode(message: string): string | undefined {
  const text = message || '';
  const realCode = text.match(/\bF\d{2}-[A-Z0-9]{3}\.\d{3,6}\b/i)?.[0];
  if (realCode) return realCode.toUpperCase();

  const shortCode = text.match(/\bF[-\s]?\d+\b/i)?.[0];
  if (shortCode) return shortCode.replace(/\s+/g, '').toUpperCase();

  return undefined;
}

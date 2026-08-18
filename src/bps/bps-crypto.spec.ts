import { randomBytes } from 'crypto';
import { decryptSecret, encryptSecret, loadBpsKey } from './bps-crypto';

describe('bps-crypto', () => {
  const key = randomBytes(32);

  it('roundtrip cifra y descifra', () => {
    const secret = 'contraseña-bps-áéíóú-123';
    const payload = encryptSecret(secret, key);
    expect(payload.split('.')).toHaveLength(3);
    expect(payload).not.toContain(secret);
    expect(decryptSecret(payload, key)).toBe(secret);
  });

  it('cada cifrado usa IV distinto', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });

  it('falla con clave incorrecta', () => {
    const payload = encryptSecret('secreto', key);
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow();
  });

  it('falla si el payload fue alterado (auth tag)', () => {
    const payload = encryptSecret('secreto', key);
    const [iv, tag, enc] = payload.split('.');
    const tampered = Buffer.from(enc, 'base64');
    tampered[0] ^= 0xff;
    expect(() => decryptSecret([iv, tag, tampered.toString('base64')].join('.'), key)).toThrow();
    expect(() => decryptSecret('no-es-un-payload', key)).toThrow();
  });

  describe('loadBpsKey', () => {
    it('acepta 32 bytes en base64', () => {
      expect(loadBpsKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    });
    it('rechaza clave faltante o de largo incorrecto', () => {
      expect(() => loadBpsKey(undefined)).toThrow();
      expect(() => loadBpsKey(randomBytes(16).toString('base64'))).toThrow();
    });
  });
});

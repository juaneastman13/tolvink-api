import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM para credenciales BPS en reposo.
// Formato del payload: base64(iv).base64(authTag).base64(ciphertext)

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Parsea BPS_ENCRYPTION_KEY (base64 de 32 bytes). Lanza si es inválida. */
export function loadBpsKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('BPS_ENCRYPTION_KEY no está configurada');
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('BPS_ENCRYPTION_KEY no es base64 válido');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`BPS_ENCRYPTION_KEY debe ser ${KEY_BYTES} bytes en base64 (generar con: openssl rand -base64 32)`);
  }
  return key;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

/** Lanza si el payload está corrupto o fue alterado (falla del auth tag). */
export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Payload de credencial inválido');
  const [iv, tag, enc] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

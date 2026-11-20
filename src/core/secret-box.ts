import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM ciphertext as stored in Mongo. */
export interface SealedSecret {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export interface SecretBox {
  seal(plaintext: string): SealedSecret;
  open(sealed: SealedSecret): string;
}

/** Decodes ENCRYPTION_KEY: 32 bytes as base64 (44 chars) or hex (64 chars). Throws otherwise. */
export function parseEncryptionKey(text: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, base64- or hex-encoded (`openssl rand -base64 32`)');
  }
  return key;
}

export function createSecretBox(encryptionKey: string): SecretBox {
  const key = parseEncryptionKey(encryptionKey);
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(sealed) {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

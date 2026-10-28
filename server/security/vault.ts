import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface EncryptedSecret {
  ciphertext: string
  iv: string
  tag: string
}

export class CredentialVault {
  private readonly key: Buffer

  constructor(secret: string) {
    if (!secret || secret.length < 16) {
      throw new Error('VAULT_KEY 至少需要 16 个字符')
    }
    this.key = createHash('sha256').update(secret).digest()
  }

  encrypt(plaintext: string): EncryptedSecret {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
  }

  decrypt(secret: EncryptedSecret): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(secret.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }

  hint(plaintext: string): string {
    return `••••••••${plaintext.slice(-4) || '****'}`
  }
}

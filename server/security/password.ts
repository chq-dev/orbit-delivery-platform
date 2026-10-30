import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const SALT_LENGTH = 16
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export function passwordValidationError(value: unknown): string | undefined {
  if (typeof value !== 'string') return '密码必须是字符串'
  if (value.length < 8) return '密码至少需要 8 个字符'
  if (value.length > 128) return '密码不能超过 128 个字符'
  if (!/\p{L}/u.test(value) || !/\p{N}/u.test(value)) return '密码必须同时包含字母和数字'
  return undefined
}

export async function hashPassword(password: string): Promise<string> {
  const validationError = passwordValidationError(password)
  if (validationError) throw new Error(validationError)
  const salt = randomBytes(SALT_LENGTH)
  const key = await deriveKey(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  })
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (
    !Number.isInteger(n) || n < 1_024 || n > 1_048_576 ||
    !Number.isInteger(r) || r < 1 || r > 32 ||
    !Number.isInteger(p) || p < 1 || p > 16
  ) {
    return false
  }
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64url')
    expected = Buffer.from(parts[5], 'base64url')
  } catch {
    return false
  }
  if (salt.length < 8 || expected.length < 32) return false
  try {
    const actual = await deriveKey(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAX_MEMORY,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

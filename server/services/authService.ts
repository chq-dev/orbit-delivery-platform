import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { AppError, conflict, unprocessable } from '../domain/errors.js'
import { nowIso } from '../domain/time.js'
import { hashPassword, passwordValidationError, verifyPassword } from '../security/password.js'

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,64}$/u
const SESSION_TOKEN_BYTES = 32
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$t0-1hIMq1AEbGjLfsBEqnw$ZmkJLLEg89XxF5NU5rfCia0ZsULXKJ0hUyvviSFmt_ofL9Pq0uvATawb9X2ShrKJDSeMLSmByoqdgxVlcW3dLQ'

export interface AuthUser {
  id: string
  username: string
  createdAt: string
}

export interface AuthSession {
  user: AuthUser
  token: string
  expiresAt: string
}

interface UserRow {
  id: string
  username: string
  username_normalized: string
  password_hash: string
  created_at: string
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') throw unprocessable('用户名必须是字符串')
  const username = value.normalize('NFKC').trim()
  if (!USERNAME_PATTERN.test(username)) {
    throw unprocessable('用户名需为 3–64 个字符，只能包含文字、数字、点、下划线或短横线')
  }
  return username
}

function normalizedKey(username: string): string {
  return username.toLocaleLowerCase('zh-CN')
}

function publicUser(row: UserRow): AuthUser {
  return { id: row.id, username: row.username, createdAt: row.created_at }
}

function passwordFromInput(value: unknown): string {
  const error = passwordValidationError(value)
  if (error) throw unprocessable(error)
  return value as string
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function parseExpiry(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function isUniqueViolation(error: unknown): boolean {
  return String((error as { code?: unknown } | null)?.code ?? '').startsWith('SQLITE_CONSTRAINT')
}

export async function registerUser(
  db: AppDatabase,
  input: { username?: unknown; password?: unknown },
): Promise<AuthUser> {
  const username = normalizeUsername(input.username)
  const password = passwordFromInput(input.password)
  const passwordHash = await hashPassword(password)
  const now = nowIso()
  const id = `user-${randomUUID()}`
  try {
    db.prepare(
      `INSERT INTO users
        (id, username, username_normalized, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, username, normalizedKey(username), passwordHash, now, now)
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('该用户名已被注册')
    throw error
  }
  return { id, username, createdAt: now }
}

export async function authenticateUser(
  db: AppDatabase,
  input: { username?: unknown; password?: unknown },
): Promise<AuthUser> {
  const username = normalizeUsername(input.username)
  const password = passwordFromInput(input.password)
  const row = db
    .prepare(
      `SELECT id, username, username_normalized, password_hash, created_at
       FROM users WHERE username_normalized = ?`,
    )
    .get(normalizedKey(username)) as UserRow | undefined
  if (!row) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH)
    throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确')
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确')
  }
  return publicUser(row)
}

export function createUserSession(
  db: AppDatabase,
  user: AuthUser,
  ttlSeconds: number,
): AuthSession {
  const now = nowIso()
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString()
  db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now)
  db.prepare(
    `INSERT INTO user_sessions
      (token_hash, user_id, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash(token), user.id, expiresAt, now, now)
  return { user, token, expiresAt }
}

export function userForSessionToken(db: AppDatabase, token: string): AuthUser | undefined {
  if (!token) return undefined
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.username_normalized, u.password_hash, u.created_at,
              s.expires_at, s.last_seen_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as (UserRow & { expires_at: string; last_seen_at: string }) | undefined
  if (!row) return undefined
  if (parseExpiry(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(tokenHash(token))
    return undefined
  }
  if (Date.now() - parseExpiry(row.last_seen_at) > 3_600_000) {
    db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?').run(
      nowIso(),
      tokenHash(token),
    )
  }
  return publicUser(row)
}

export function revokeSession(db: AppDatabase, token: string): void {
  if (!token) return
  db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(tokenHash(token))
}

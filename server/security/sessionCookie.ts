export const SESSION_COOKIE_NAME = 'orbit_session'

export function parseSessionCookie(cookieHeader: string | undefined): string {
  if (!cookieHeader) return ''
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue
    const value = part.slice(separator + 1).trim()
    return /^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : ''
  }
  return ''
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure)
}

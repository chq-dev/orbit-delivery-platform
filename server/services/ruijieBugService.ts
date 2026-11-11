import { createCipheriv } from 'node:crypto'
import type { AppDatabase } from '../db/database.js'
import { AppError, notFound, unprocessable } from '../domain/errors.js'
import { formatDisplayTime, nowIso } from '../domain/time.js'
import type { Priority, WorkItemType } from '../domain/types.js'
import { optionalText, requiredText } from '../domain/validation.js'
import type { CredentialVault } from '../security/vault.js'
import { getAccount, getAccountSecret } from './accountService.js'
import { upsertRuijieWorkItems, type SyncedRuijieWorkItem } from './workItemService.js'

const DEFAULT_BASE_URL = 'http://bugs.ruijie.com.cn/bug_switch'
const MAX_BUGS = 100
const REQUEST_TIMEOUT_MS = 20_000
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'

export interface RuijieSyncInput {
  accountId: unknown
  repoId: unknown
  bugIds?: unknown
  keyword?: unknown
  limit?: unknown
}

export interface RuijieBugSummary {
  bugId: string
  title: string
  url: string
  priority: Priority
}

export interface RuijieSyncResult {
  accountId: string
  username: string
  fetched: number
  created: number
  updated: number
  bugs: RuijieBugSummary[]
  message: string
  syncedAt: string
}

export interface RuijieConnectionResult {
  ok: true
  accountId: string
  username: string
  baseUrl: string
  message: string
}

interface RuijieBug {
  bugId: string
  title: string
  description: string
  priority: Priority
  owner: string
  updatedAt: string
  projectLine?: string
}

interface StoredCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  hostOnly: boolean
  expiresAt?: number
}

class CookieJar {
  private readonly cookies: StoredCookie[] = []

  header(url: URL): string {
    const now = Date.now()
    return this.cookies
      .filter((cookie) => cookieMatches(cookie, url, now))
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  add(setCookieHeaders: string[], url: URL): void {
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header, url)
      if (!cookie) continue
      const index = this.cookies.findIndex(
        (entry) =>
          entry.name === cookie.name &&
          entry.domain === cookie.domain &&
          entry.path === cookie.path,
      )
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
        if (index >= 0) this.cookies.splice(index, 1)
        continue
      }
      if (index >= 0) this.cookies.splice(index, 1)
      this.cookies.push(cookie)
    }
  }
}

interface HttpResponse {
  response: Response
  url: string
  text: string
}

interface RuijieSession {
  jar: CookieJar
  baseUrl: string
  username: string
}

interface ParsedResponse {
  url: string
  status: number
  contentType: string
  text: string
  json?: unknown
}

function normalizeBaseUrl(serviceUrl?: string): string {
  const raw = serviceUrl?.trim() || DEFAULT_BASE_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw unprocessable('锐捷 BUG 系统服务地址不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw unprocessable('锐捷 BUG 系统仅支持 http/https 服务地址')
  }
  const marker = '/bug_switch'
  const index = url.pathname.indexOf(marker)
  if (index >= 0) {
    return `${url.origin}${url.pathname.slice(0, index + marker.length)}`
  }
  return `${url.origin}${marker}`
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/'
  const index = pathname.lastIndexOf('/')
  return index <= 0 ? '/' : pathname.slice(0, index)
}

function parseSetCookie(header: string, requestUrl: URL): StoredCookie | undefined {
  const parts = header.split(';').map((part) => part.trim()).filter(Boolean)
  const [pair, ...attributes] = parts
  if (!pair) return undefined
  const separator = pair.indexOf('=')
  if (separator <= 0) return undefined
  const name = pair.slice(0, separator).trim()
  const value = pair.slice(separator + 1).trim()
  if (!name) return undefined

  let domain = requestUrl.hostname.toLowerCase()
  let hostOnly = true
  let path = defaultCookiePath(requestUrl.pathname)
  let secure = false
  let expiresAt: number | undefined

  for (const attribute of attributes) {
    const attributeSeparator = attribute.indexOf('=')
    const key = (attributeSeparator >= 0 ? attribute.slice(0, attributeSeparator) : attribute)
      .trim()
      .toLowerCase()
    const attributeValue =
      attributeSeparator >= 0 ? attribute.slice(attributeSeparator + 1).trim() : ''
    if (key === 'domain' && attributeValue) {
      domain = attributeValue.replace(/^\./, '').toLowerCase()
      hostOnly = false
    } else if (key === 'path' && attributeValue.startsWith('/')) {
      path = attributeValue
    } else if (key === 'secure') {
      secure = true
    } else if (key === 'max-age') {
      const seconds = Number(attributeValue)
      if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000
    } else if (key === 'expires') {
      const timestamp = Date.parse(attributeValue)
      if (!Number.isNaN(timestamp)) expiresAt = timestamp
    }
  }

  return { name, value, domain, path, secure, hostOnly, expiresAt }
}

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') {
    const values = getSetCookie.call(headers)
    if (values.length > 0) return values
  }
  const combined = headers.get('set-cookie')
  if (!combined) return []
  return combined
    .split(/,(?=\s*[^;=,\s]+\s*=)/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function cookieMatches(cookie: StoredCookie, url: URL, now: number): boolean {
  if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) return false
  if (cookie.secure && url.protocol !== 'https:') return false
  const hostname = url.hostname.toLowerCase()
  const domainMatches = cookie.hostOnly
    ? hostname === cookie.domain
    : hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`)
  if (!domainMatches) return false
  if (cookie.path === '/') return true
  return url.pathname === cookie.path || url.pathname.startsWith(`${cookie.path}/`)
}

function redirectRequestInit(
  status: number,
  method: string,
  body: RequestInit['body'],
  headers: Headers,
): { method: string; body: RequestInit['body']; headers: Headers } {
  if (
    status === 303 ||
    ((status === 301 || status === 302) && method.toUpperCase() === 'POST')
  ) {
    const nextHeaders = new Headers(headers)
    nextHeaders.delete('content-type')
    nextHeaders.delete('content-length')
    return { method: 'GET', body: undefined, headers: nextHeaders }
  }
  return { method, body, headers }
}

async function fetchWithCookies(
  jar: CookieJar,
  inputUrl: string,
  init: RequestInit = {},
  maxRedirects = 12,
): Promise<HttpResponse> {
  let currentUrl = new URL(inputUrl)
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  let headers = new Headers(init.headers)
  headers.set('user-agent', USER_AGENT)
  headers.set('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json, text/html, text/plain, */*')
  }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const cookie = jar.header(currentUrl)
    if (cookie) headers.set('cookie', cookie)
    else headers.delete('cookie')

    const response = await fetch(currentUrl, {
      method,
      body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    jar.add(setCookieHeaders(response.headers), currentUrl)

    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      const nextUrl = new URL(location, currentUrl)
      const next = redirectRequestInit(response.status, method, body, headers)
      method = next.method
      body = next.body
      headers = next.headers
      currentUrl = nextUrl
      continue
    }

    return { response, url: currentUrl.toString(), text: await response.text() }
  }

  throw unprocessable('锐捷 BUG 系统重定向次数过多')
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li|tr|h\d|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

function htmlValues(html: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const match of html.matchAll(/<p[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/p>/gi)) {
    values.set(match[1], stripHtml(match[2]))
  }
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0]
    const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1]
    const id = /\bid=["']([^"']+)["']/i.exec(tag)?.[1]
    const value = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    const decoded = decodeHtml(value)
    if (name && !values.has(name)) values.set(name, decoded)
    if (id && !values.has(id)) values.set(id, decoded)
  }
  return values
}

function isLoginPage(url: string, html: string): boolean {
  return (
    url.includes('sid.ruijie.com.cn/login') ||
    html.includes('login-croypto') ||
    html.includes('login-page-flowkey') ||
    /统一身份认证平台/.test(html)
  )
}

function loginErrorMessage(html: string): string {
  const text = stripHtml(html)
  for (const message of [
    '用户名或密码错误',
    '账号或密码错误',
    '密码错误',
    '用户不存在',
    '账号已被锁定',
    '验证码错误',
  ]) {
    if (text.includes(message)) return message
  }
  const match = /id=["']login-error-msg["'][^>]*>([\s\S]*?)</i.exec(html)
  return match ? stripHtml(match[1]).slice(0, 200) : '用户名或密码错误'
}

function encryptPassword(password: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64')
  if (![16, 24, 32].includes(key.length)) {
    throw unprocessable('锐捷 BUG 系统登录密钥格式不正确')
  }
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
  return Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]).toString('base64')
}

async function loginRuijie(
  baseUrl: string,
  username: string,
  password: string,
): Promise<RuijieSession> {
  const jar = new CookieJar()
  const entryUrl = `${baseUrl}/bug/main`
  const entry = await fetchWithCookies(jar, entryUrl)
  if (!isLoginPage(entry.url, entry.text)) {
    return { jar, baseUrl, username }
  }

  const loginValues = htmlValues(entry.text)
  const croypto = loginValues.get('login-croypto') ?? ''
  const execution = loginValues.get('login-page-flowkey') ?? ''
  if (!croypto || !execution) {
    throw unprocessable('无法解析锐捷统一身份认证登录页，请稍后重试')
  }

  const loginUrl = new URL(entry.url)
  const form = new URLSearchParams({
    username,
    type: loginValues.get('current-login-type') || 'UsernamePassword',
    _eventId: 'submit',
    geolocation: '',
    execution,
    captcha_code: '',
    croypto,
    password: encryptPassword(password, croypto),
    captcha_payload: encryptPassword('', croypto),
    targetSystem: 'sso',
    siteId: 'sourceId',
    riskEngine: 'true',
  })
  const result = await fetchWithCookies(jar, `${loginUrl.origin}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: loginUrl.origin,
      referer: entry.url,
    },
    body: form.toString(),
  })

  if (
    result.response.status === 401 ||
    isLoginPage(result.url, result.text)
  ) {
    throw new AppError(
      401,
      'RUIJIE_LOGIN_FAILED',
      `锐捷 BUG 系统登录失败：${loginErrorMessage(result.text)}`,
    )
  }

  const verify = await fetchWithCookies(jar, entryUrl)
  if (isLoginPage(verify.url, verify.text)) {
    throw new AppError(
      401,
      'RUIJIE_LOGIN_FAILED',
      '锐捷 BUG 系统登录未建立有效会话，请检查账号权限',
    )
  }
  return { jar, baseUrl, username }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

async function requestEndpoint(
  session: RuijieSession,
  path: string,
  init: RequestInit = {},
): Promise<ParsedResponse> {
  const result = await fetchWithCookies(session.jar, `${session.baseUrl}${path}`, init)
  if (isLoginPage(result.url, result.text)) {
    throw new AppError(401, 'RUIJIE_SESSION_EXPIRED', '锐捷 BUG 系统会话已失效，请重新同步')
  }
  return {
    url: result.url,
    status: result.response.status,
    contentType: result.response.headers.get('content-type') ?? '',
    text: result.text,
    json: parseJson(result.text),
  }
}

async function postPayload(
  session: RuijieSession,
  path: string,
  payload: Record<string, unknown>,
): Promise<ParsedResponse> {
  const jsonResult = await requestEndpoint(session, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/html' },
    body: JSON.stringify(payload),
  })
  if (
    jsonResult.status !== 400 &&
    jsonResult.status !== 404 &&
    jsonResult.status !== 405 &&
    jsonResult.status !== 415
  ) {
    return jsonResult
  }
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue
    form.set(key, String(value))
  }
  return requestEndpoint(session, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json, text/html',
    },
    body: form.toString(),
  })
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function comparableRecord(record: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const [key, value] of Object.entries(record)) map.set(normalizeKey(key), value)
  return map
}

function valueFrom(
  map: Map<string, unknown>,
  aliases: string[],
): unknown {
  for (const alias of aliases) {
    const value = map.get(normalizeKey(alias))
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return stripHtml(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    for (const key of ['name', 'label', 'title', 'value', 'text', 'id']) {
      const nested = record[key]
      if (typeof nested === 'string' || typeof nested === 'number') return String(nested)
    }
  }
  return ''
}

function priorityFrom(value: unknown): Priority {
  const text = scalarText(value).toLowerCase()
  if (/致命|严重|紧急|blocker|critical|^p0$|^p1$|^1$/.test(text)) return '紧急'
  if (/高|major|high|^p2$|^2$/.test(text)) return '高'
  if (/低|轻微|建议|minor|low|^p4$|^4$/.test(text)) return '低'
  return '中'
}

function timestampFrom(value: unknown): string {
  if (value === undefined || value === null || value === '') return nowIso()
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const numeric = Number(value)
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return nowIso()
}

function bugUrl(baseUrl: string, bugId: string): string {
  return `${baseUrl}/bug/main?bugId=${encodeURIComponent(bugId)}`
}

function normalizeBugRecord(
  record: Record<string, unknown>,
  baseUrl: string,
  requestedId?: string,
): RuijieBug | undefined {
  const map = comparableRecord(record)
  const rawId = valueFrom(map, [
    'bugId',
    'bug_id',
    'bugIdStr',
    'issueId',
    'defectId',
    'id',
  ])
  const bugId = scalarText(rawId) || requestedId || ''
  if (!bugId || !/^[A-Za-z0-9_.-]{1,80}$/.test(bugId)) return undefined
  if (requestedId && bugId !== requestedId) return undefined

  const rawDescription = valueFrom(map, [
    'bugDesc',
    'bugDescription',
    'description',
    'bugContent',
    'content',
    'detail',
    'bugDetail',
    'reproduceSteps',
    'remark',
  ])
  const descriptionText = scalarText(rawDescription)
  const rawTitle = valueFrom(map, ['bugTitle', 'title', 'bugName', 'summary', 'subject', 'name'])
  const titleText = scalarText(rawTitle)
  const fallbackTitle = descriptionText.split('\n').map((line) => line.trim()).find(Boolean)
  const title = (titleText || fallbackTitle || `BUG ${bugId}`).slice(0, 300)
  const owner =
    scalarText(
      valueFrom(map, ['bugHandler', 'handler', 'assignee', 'bugOwner', 'owner', 'developer']),
    ) || '锐捷 BUG 同步'
  const product = scalarText(valueFrom(map, ['bugProduct', 'product', 'productName', 'project']))
  const module = scalarText(valueFrom(map, ['bugModule', 'module', 'moduleName', 'component']))
  const projectLine = [product, module].filter(Boolean).join(' / ').slice(0, 500) || undefined
  const updatedAt = timestampFrom(
    valueFrom(map, [
      'updateTime',
      'updatedAt',
      'modifyTime',
      'gmtModified',
      'lastModified',
      'createTime',
      'createdAt',
    ]),
  )
  const link = bugUrl(baseUrl, bugId)
  const description = `${descriptionText || title}\n\nBUG详情：${link}`.slice(0, 20_000)

  return {
    bugId,
    title,
    description,
    priority: priorityFrom(valueFrom(map, ['bugPriority', 'priority', 'priorityName', 'severity', 'level'])),
    owner: owner.slice(0, 100),
    updatedAt,
    projectLine,
  }
}

function looksLikeBugRecord(record: Record<string, unknown>, requestedId?: string): boolean {
  const map = comparableRecord(record)
  const id = scalarText(valueFrom(map, ['bugId', 'bug_id', 'bugIdStr', 'issueId', 'defectId', 'id']))
  if (requestedId) return id === requestedId
  const title = scalarText(valueFrom(map, ['bugTitle', 'title', 'bugName', 'summary', 'subject']))
  const description = scalarText(
    valueFrom(map, ['bugDesc', 'bugDescription', 'description', 'bugContent', 'content']),
  )
  return Boolean(id && (title || description))
}

function collectBugRecords(
  value: unknown,
  baseUrl: string,
  requestedId?: string,
  depth = 0,
): RuijieBug[] {
  if (depth > 8 || value === null || value === undefined) return []
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectBugRecords(entry, baseUrl, requestedId, depth + 1))
  }
  if (typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (looksLikeBugRecord(record, requestedId)) {
    const normalized = normalizeBugRecord(record, baseUrl, requestedId)
    return normalized ? [normalized] : []
  }
  const found: RuijieBug[] = []
  for (const entry of Object.values(record)) {
    found.push(...collectBugRecords(entry, baseUrl, requestedId, depth + 1))
  }
  return found
}

function dedupeBugs(bugs: RuijieBug[]): RuijieBug[] {
  const byId = new Map<string, RuijieBug>()
  for (const bug of bugs) {
    const existing = byId.get(bug.bugId)
    if (!existing || bug.description.length > existing.description.length) byId.set(bug.bugId, bug)
  }
  return [...byId.values()]
}

function findJsonObjectsWithBugId(html: string): unknown[] {
  const values: unknown[] = []
  const seen = new Set<number>()
  for (const match of html.matchAll(/["']?bug[_]?id["']?\s*:/gi)) {
    const startIndex = match.index ?? 0
    let start = html.lastIndexOf('{', startIndex)
    while (start >= 0 && !seen.has(start)) {
      seen.add(start)
      let depth = 0
      let inString = false
      let quote = ''
      let escaped = false
      for (let index = start; index < html.length; index += 1) {
        const character = html[index]
        if (inString) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === quote) inString = false
          continue
        }
        if (character === '"' || character === "'") {
          inString = true
          quote = character
          continue
        }
        if (character === '{') depth += 1
        else if (character === '}') {
          depth -= 1
          if (depth === 0) {
            const parsed = parseJson(html.slice(start, index + 1))
            if (parsed) values.push(parsed)
            break
          }
        }
      }
      start = html.lastIndexOf('{', start - 1)
    }
  }
  return values
}

function titleFromHtml(html: string): string {
  const candidates = [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<(?:div|span|td)[^>]*(?:id|class)=["'][^"']*(?:bugTitle|bug-title|title)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|td)>/i,
  ]
  for (const expression of candidates) {
    const match = expression.exec(html)
    const title = match ? stripHtml(match[1]).replace(/\s+/g, ' ').trim() : ''
    if (
      title &&
      !/统一身份认证|锐捷.*BUG系统|BUG管理系统|BUG系统$/i.test(title) &&
      title.length <= 500
    ) {
      return title
    }
  }
  return ''
}

function descriptionFromHtml(html: string): string {
  const blocks = [
    /<(?:div|td|section|article|pre|textarea)[^>]*(?:id|class)=["'][^"']*(?:bugDesc|bug-desc|bugDescription|bug-description|bugContent|bug-content|bugDetail|bug-detail|description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|td|section|article|pre|textarea)>/i,
  ]
  for (const expression of blocks) {
    const match = expression.exec(html)
    const text = match ? stripHtml(match[1]) : ''
    if (text.length > 10) return text.slice(0, 18_000)
  }
  const text = stripHtml(
    html
      .replace(/^[\s\S]*?<body[^>]*>/i, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ''),
  )
  return text.slice(0, 18_000)
}

function bugFromHtml(
  html: string,
  baseUrl: string,
  bugId: string,
): RuijieBug | undefined {
  if (isLoginPage('', html)) return undefined
  for (const object of findJsonObjectsWithBugId(html)) {
    const [bug] = collectBugRecords(object, baseUrl, bugId)
    if (bug) return bug
  }
  const title = titleFromHtml(html)
  const description = descriptionFromHtml(html)
  if (!title && !description) return undefined
  const link = bugUrl(baseUrl, bugId)
  return {
    bugId,
    title: (title || `BUG ${bugId}`).slice(0, 300),
    description: `${description || title}\n\nBUG详情：${link}`.slice(0, 20_000),
    priority: priorityFrom(/优先级[：:]\s*([^\s<]+)/.exec(stripHtml(html))?.[1]),
    owner:
      /(?:处理人|指派人|负责人)[：:]\s*([^\s<]{1,30})/.exec(stripHtml(html))?.[1] ??
      '锐捷 BUG 同步',
    updatedAt: timestampFrom(
      /(?:更新时间|修改时间|创建时间)[：:]\s*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}[^\s<]*)/.exec(
        stripHtml(html),
      )?.[1],
    ),
  }
}

function bugsFromResponse(
  parsed: ParsedResponse,
  baseUrl: string,
  requestedId?: string,
): RuijieBug[] {
  if (parsed.json !== undefined) return dedupeBugs(collectBugRecords(parsed.json, baseUrl, requestedId))
  if (parsed.text) {
    const inline = findJsonObjectsWithBugId(parsed.text)
    const fromInline = inline.flatMap((value) => collectBugRecords(value, baseUrl, requestedId))
    if (fromInline.length > 0) return dedupeBugs(fromInline)
    if (requestedId) {
      const fromHtml = bugFromHtml(parsed.text, baseUrl, requestedId)
      if (fromHtml) return [fromHtml]
    }
  }
  return []
}

async function fetchBugDetail(
  session: RuijieSession,
  bugId: string,
): Promise<RuijieBug> {
  const encoded = encodeURIComponent(bugId)
  const endpoints: Array<{ path: string; method?: 'GET' | 'POST' }> = [
    { path: `/bug/bug_info?bugId=${encoded}` },
    { path: `/bug/get_bug_info_params?bugId=${encoded}` },
    { path: `/bug/bug_check_exist?bugId=${encoded}` },
    { path: `/bug/main?bugId=${encoded}` },
    { path: `/bug/bug_info?bug_id=${encoded}` },
  ]
  for (const endpoint of endpoints) {
    try {
      const parsed = await requestEndpoint(session, endpoint.path, {
        method: endpoint.method ?? 'GET',
        headers: { accept: 'application/json, text/html' },
      })
      if (parsed.status >= 400) continue
      const bugs = bugsFromResponse(parsed, session.baseUrl, bugId)
      const bug = bugs.find((entry) => entry.bugId === bugId)
      if (bug) return bug
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'RUIJIE_SESSION_EXPIRED') {
        throw error
      }
    }
  }

  const list = await loadBugList(session, { bugId, limit: 20 })
  const bug = list.find((entry) => entry.bugId === bugId)
  if (bug) return bug
  throw unprocessable(`未获取到 BUG ${bugId}，请确认编号与当前账号权限`)
}

function bugIdsFromHtml(html: string, limit: number): string[] {
  const ids = new Set<string>()
  for (const match of html.matchAll(/(?:bugId|bug_id)=([0-9]{4,20})/gi)) {
    ids.add(match[1])
    if (ids.size >= limit) break
  }
  return [...ids]
}

async function loadBugList(
  session: RuijieSession,
  query: { bugId?: string; keyword?: string; limit: number },
): Promise<RuijieBug[]> {
  const keyword = query.keyword?.trim() ?? ''
  const payload = {
    pageNum: 1,
    page: 1,
    pageSize: query.limit,
    limit: query.limit,
    rows: query.limit,
    bugId: query.bugId ?? '',
    bugTitle: keyword,
    keyword,
    searchKey: keyword,
    key: keyword,
    bugState: '',
    bugHandler: '',
    bugCreateUser: '',
    bugProduct: '',
    bugModule: '',
    orderBy: 'bugId',
    order: 'desc',
  }

  const attempts: Array<() => Promise<ParsedResponse>> = []
  if (!query.bugId && !keyword) {
    attempts.push(() => postPayload(session, '/bug/load_attention_bug_list', {}))
  }
  attempts.push(() => postPayload(session, '/bug/load_bug_list', payload))
  if (keyword) {
    const encoded = encodeURIComponent(keyword)
    attempts.push(() =>
      requestEndpoint(session, `/bug/bug_search?searchKey=${encoded}`, {
        headers: { accept: 'application/json, text/html' },
      }),
    )
    attempts.push(() =>
      requestEndpoint(session, `/bug/bug_list?searchKey=${encoded}&bugTitle=${encoded}`, {
        headers: { accept: 'application/json, text/html' },
      }),
    )
  }

  const found: RuijieBug[] = []
  for (const attempt of attempts) {
    try {
      const parsed = await attempt()
      if (parsed.status >= 400) continue
      found.push(...bugsFromResponse(parsed, session.baseUrl, query.bugId))
      if (found.length === 0) {
        const ids = bugIdsFromHtml(parsed.text, query.limit)
        for (const bugId of ids) {
          if (found.some((bug) => bug.bugId === bugId)) continue
          try {
            const detail = await fetchBugDetail(session, bugId)
            found.push(detail)
          } catch {
            // Keep scanning the remaining ids when one detail is not accessible.
          }
          if (found.length >= query.limit) break
        }
      }
      if (found.length >= query.limit) break
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'RUIJIE_SESSION_EXPIRED') {
        throw error
      }
    }
  }
  return dedupeBugs(found).slice(0, query.limit)
}

function parseBugIds(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  const rawValues = Array.isArray(value) ? value : [value]
  const ids = new Set<string>()
  for (const raw of rawValues) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue
    const text = String(raw)
    for (const match of text.matchAll(/(?:bugId=|bug_id=|bugs?\/)?([0-9]{4,20})/gi)) {
      if (match[1]) ids.add(match[1])
      if (ids.size >= MAX_BUGS) break
    }
    if (ids.size >= MAX_BUGS) break
  }
  return [...ids]
}

function positiveLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return 20
  return Math.min(parsed, MAX_BUGS)
}

function repositoryForSync(db: AppDatabase, repoId: string, ownerUserId?: string) {
  const row = db
    .prepare(
      ownerUserId === undefined
        ? 'SELECT id, owner_user_id FROM repositories WHERE id = ?'
        : 'SELECT id, owner_user_id FROM repositories WHERE id = ? AND owner_user_id = ?',
    )
    .get(...(ownerUserId === undefined ? [repoId] : [repoId, ownerUserId])) as
    | { id: string; owner_user_id: string }
    | undefined
  if (!row) throw notFound('关联仓库')
  return row
}

export async function testRuijieBugConnection(
  db: AppDatabase,
  vault: CredentialVault,
  accountId: string,
  ownerUserId?: string,
): Promise<RuijieConnectionResult> {
  const account = getAccount(db, accountId, ownerUserId)
  if (account.platform !== 'ruijie') throw unprocessable('请选择锐捷 BUG 系统账号')
  const baseUrl = normalizeBaseUrl(account.serviceUrl)
  const password = getAccountSecret(db, vault, account.id)
  await loginRuijie(baseUrl, account.username, password)
  return {
    ok: true,
    accountId: account.id,
    username: account.username,
    baseUrl,
    message: '锐捷 BUG 系统登录成功',
  }
}

export async function syncRuijieBugs(
  db: AppDatabase,
  vault: CredentialVault,
  input: RuijieSyncInput,
  ownerUserId?: string,
): Promise<RuijieSyncResult> {
  const accountId = requiredText(input.accountId, 'BUG 系统账号', { max: 200 })
  const repoId = requiredText(input.repoId, '关联仓库', { max: 200 })
  const account = getAccount(db, accountId, ownerUserId)
  if (account.platform !== 'ruijie') throw unprocessable('请选择锐捷 BUG 系统账号')
  repositoryForSync(db, repoId, ownerUserId)

  const password = getAccountSecret(db, vault, account.id)
  const baseUrl = normalizeBaseUrl(account.serviceUrl)
  const session = await loginRuijie(baseUrl, account.username, password)
  const bugIds = parseBugIds(input.bugIds)
  const keyword = optionalText(input.keyword, 'BUG 关键词', 200) ?? ''
  const limit = positiveLimit(input.limit)

  let bugs: RuijieBug[] = []
  const failures: string[] = []
  if (bugIds.length > 0) {
    for (const bugId of bugIds.slice(0, limit)) {
      try {
        bugs.push(await fetchBugDetail(session, bugId))
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `BUG ${bugId} 获取失败`)
      }
    }
  } else {
    bugs = await loadBugList(session, { keyword: keyword || undefined, limit })
  }

  bugs = dedupeBugs(bugs).slice(0, limit)
  if (bugs.length === 0) {
    const detail = failures[0] ?? '未获取到 BUG'
    throw new AppError(
      404,
      'RUIJIE_BUG_NOT_FOUND',
      `${detail}。请填写 BUG 编号/链接，或确认账号有查看 BUG 的权限`,
    )
  }

  const synced: SyncedRuijieWorkItem[] = bugs.map((bug) => ({
    externalId: `ruijie:${bug.bugId}`,
    type: 'defect' as WorkItemType,
    title: bug.title,
    description: bug.description,
    priority: bug.priority,
    owner: bug.owner,
    updatedAt: bug.updatedAt,
    projectLine: bug.projectLine,
  }))
  const result = upsertRuijieWorkItems(db, repoId, synced)
  return {
    accountId: account.id,
    username: account.username,
    fetched: bugs.length,
    created: result.created,
    updated: result.updated,
    bugs: bugs.map((bug) => ({
      bugId: bug.bugId,
      title: bug.title,
      url: bugUrl(baseUrl, bug.bugId),
      priority: bug.priority,
    })),
    message: `已从锐捷 BUG 系统获取 ${bugs.length} 条缺陷，新增 ${result.created} 条、更新 ${result.updated} 条${
      failures.length > 0 ? `，${failures.length} 条获取失败` : ''
    }`,
    syncedAt: formatDisplayTime(nowIso()),
  }
}

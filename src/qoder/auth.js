/**
 * Qoder 登录协议：PAT（pt-…）换 jobToken；或浏览器设备授权（PKCE 轮询）。
 *
 * 协议来源：
 *  - 玖念/traework2api 的 QoderAuthApi.kt（PAT / userinfo / 续期）
 *  - dsh-get-it-for-free 渠道包的 qoder.ts（设备授权 + PKCE + deviceToken 轮询）
 *
 * 说明：
 *  - `jobToken/exchange`、`jobToken/refresh`、`userinfo` 都是普通 Bearer 接口，不需要 COSY 签名；
 *    只有 `/algo/` 聊天网关要签名，见 cosy.js。
 *  - 国内 / 国际是两套 host 与 client_id，不能混用。
 *  - PAT 登录得到的是 jobToken，续期用 jobToken/refresh；设备授权得到的是 device token，
 *    续期走 deviceToken/refresh。两者都存在 jobToken 字段里，用 authKind 区分。
 *
 * @module src/qoder/auth.js
 */

import crypto from 'node:crypto'
import { HttpError, request } from '../http.js'

export const REGIONS = {
  cn: {
    id: 'cn',
    label: 'Qoder 中国版（qoder.cn）',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    inferBase: 'https://gateway.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
  },
  global: {
    id: 'global',
    label: 'Qoder 国际版（qoder.com）',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    inferBase: 'https://api2-v2.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  },
}

export const DEVICE_SELECT_PATH = '/device/selectAccounts'
export const POLL_PATH = '/api/v1/deviceToken/poll'
export const DEVICE_REFRESH_PATH = '/api/v1/deviceToken/refresh'
export const JOB_REFRESH_PATH = '/api/v1/jobToken/refresh'
export const EXCHANGE_PATH = '/api/v1/jobToken/exchange'
export const USERINFO_PATH = '/api/v1/userinfo'

export function regionOf(id) {
  return REGIONS[id] ?? REGIONS.cn
}

export function machineOS() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'win32') return arch === 'arm64' ? 'aarch64_windows' : 'x86_64_windows'
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64_macos' : 'x86_64_macos'
  if (platform === 'linux') return arch === 'arm64' ? 'aarch64_linux' : 'x86_64_linux'
  return `${arch}_${platform}`
}

const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

function pkce() {
  const length = 64
  const bytes = crypto.randomBytes(length)
  let verifier = ''
  for (let i = 0; i < length; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length]
  const challenge = crypto.createHash('sha256').update(verifier).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { verifier, challenge }
}

function baseHeaders() {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'traework2api',
    'cosy-version': '1.0.1',
    'cosy-clienttype': '5',
  }
}

function stringOf(source, keys) {
  if (source === null || typeof source !== 'object') return ''
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function stringList(raw) {
  if (Array.isArray(raw)) return raw.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
  if (typeof raw === 'string') return raw.split(',').map(item => item.trim()).filter(item => item !== '')
  return []
}

/** 兼容 PAT 交换、device 轮询、refresh 三种响应。 */
function parseTokenPayload(root) {
  if (root === null || typeof root !== 'object') return {}
  const source = root.data !== null && typeof root.data === 'object' && root.token === undefined ? root.data : root
  return {
    accessToken: stringOf(source, ['token', 'device_token', 'access_token', 'jobToken']),
    refreshToken: stringOf(source, ['refresh_token', 'refreshToken', 'job_refresh_token']),
    expiresAt: timestampOf(source.expires_at ?? source.expiresAt),
    refreshTokenExpiresAt: timestampOf(source.refresh_token_expires_at ?? source.refreshTokenExpiresAt),
    uid: stringOf(source, ['user_id', 'userId', 'uid']),
    userName: stringOf(source, ['user_name', 'userName', 'name']),
    raw: source,
  }
}

function expiryFromPayload(payload) {
  if (payload.expiresAt !== undefined) return payload.expiresAt
  // 实测国内/国际 OpenAPI 的 expires_in 是毫秒；缺省按 24h。
  const raw = Number(payload.raw?.expires_in ?? 0)
  if (Number.isFinite(raw) && raw > 0) return Date.now() + (raw < 1e11 ? raw : raw)
  return Date.now() + 24 * 3600_000
}

async function postJson(url, body, { signal } = {}) {
  const response = await request(url, {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify(body),
    timeoutMs: 30_000,
    signal,
  })
  if (!response.ok) {
    throw new HttpError(`Qoder HTTP ${response.status}`, { status: response.status, body: response.text.slice(0, 300) })
  }
  return response.json
}

/** PAT → jobToken。 */
export async function exchangeJobToken(pat, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  const trimmed = String(pat ?? '').trim()
  if (trimmed === '') throw new HttpError('请粘贴 Qoder PAT（pt- 开头）')
  const payload = parseTokenPayload(await postJson(`${region.openApiBase}${EXCHANGE_PATH}`, { personal_token: trimmed }, { signal }))
  if (payload.accessToken === '') throw new HttpError('Qoder exchange 未返回 token，请确认 PAT 与区域匹配')
  return { accessToken: payload.accessToken, refreshToken: payload.refreshToken, expiresAt: expiryFromPayload(payload) }
}

/** jobRefreshToken 续期（PAT 账号）。 */
export async function refreshJobToken(jobRefreshToken, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  if (typeof jobRefreshToken !== 'string' || jobRefreshToken === '') {
    throw new HttpError('缺少 jobRefreshToken，无法续期')
  }
  const payload = parseTokenPayload(await postJson(`${region.openApiBase}${JOB_REFRESH_PATH}`, { refresh_token: jobRefreshToken }, { signal }))
  if (payload.accessToken === '') throw new HttpError('Qoder refresh 未返回 token')
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken !== '' ? payload.refreshToken : jobRefreshToken,
    expiresAt: expiryFromPayload(payload),
  }
}

/** 设备 token 续期（浏览器授权账号）。 */
export async function refreshDeviceToken(refreshTokenValue, machineId, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  if (typeof refreshTokenValue !== 'string' || refreshTokenValue === '') {
    throw new HttpError('缺少 device refresh_token，无法续期')
  }
  const payload = parseTokenPayload(await postJson(`${region.openApiBase}${DEVICE_REFRESH_PATH}`, {
    refresh_token: refreshTokenValue,
    machine_id: machineId ?? '',
  }, { signal }))
  if (payload.accessToken === '') throw new HttpError('Qoder device refresh 未返回 token')
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken !== '' ? payload.refreshToken : refreshTokenValue,
    expiresAt: expiryFromPayload(payload),
  }
}

export async function fetchUserInfo(jobToken, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  const response = await request(`${region.openApiBase}${USERINFO_PATH}`, {
    method: 'GET',
    headers: { ...baseHeaders(), authorization: `Bearer ${jobToken}` },
    timeoutMs: 30_000,
    signal,
  })
  if (!response.ok) {
    throw new HttpError(`Qoder userinfo HTTP ${response.status}`, { status: response.status, body: response.text.slice(0, 200) })
  }
  const source = response.json !== null && typeof response.json === 'object' && response.json.data !== null && typeof response.json.data === 'object'
    ? response.json.data
    : (response.json ?? {})
  return {
    uid: stringOf(source, ['uid', 'id', 'userID']),
    email: stringOf(source, ['email']),
    name: stringOf(source, ['name', 'username']),
    organizationId: stringOf(source, ['organization_id']),
    organizationName: stringOf(source, ['organization_name']),
    organizationTags: stringList(source.organization_tags),
    dataPolicyAgreed: source.data_policy_agreed === true,
    dataPolicyModifiable: source.is_data_policy_modifiable !== false,
  }
}

function buildAccount({ region, authKind, pat, tokens, machineId, info, payloadUid, payloadName }) {
  const uid = info?.uid !== '' && info?.uid !== undefined ? info.uid : (payloadUid ?? '')
  if (uid === '') throw new HttpError('Qoder 未返回账号 ID，请确认 PAT 与区域（国内/国际）匹配')
  return {
    id: `qoder-${region.id}-${uid}`,
    uid,
    name: info?.name !== '' && info?.name !== undefined ? info.name : (payloadName || `Qoder ${uid.slice(-4)}`),
    email: info?.email ?? '',
    region: region.id,
    authKind,
    pat: authKind === 'pat' ? pat : '',
    jobToken: tokens.accessToken,
    jobRefreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    machineId: machineId ?? crypto.randomUUID(),
    organizationId: info?.organizationId ?? '',
    organizationName: info?.organizationName ?? '',
    organizationTags: info?.organizationTags ?? [],
    dataPolicyAgreed: info?.dataPolicyAgreed === true,
    dataPolicyModifiable: info?.dataPolicyModifiable !== false,
  }
}

/** PAT 登录（推荐路径，最稳）。 */
export async function loginWithPat(pat, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  const tokens = await exchangeJobToken(pat, region.id, { signal })
  const info = await fetchUserInfo(tokens.accessToken, region.id, { signal })
  return buildAccount({
    region,
    authKind: 'pat',
    pat: String(pat).trim(),
    tokens,
    machineId: crypto.randomUUID(),
    info,
  })
}

/** 创建设备授权会话（不联网）。 */
export function createDeviceSession(regionId) {
  return {
    region: regionOf(regionId).id,
    nonce: crypto.randomUUID(),
    machineId: crypto.randomUUID(),
    pkce: pkce(),
    createdAt: Date.now(),
  }
}

export function buildAuthUrl(session) {
  const region = regionOf(session.region)
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: region.clientId,
  })
  return `${region.authBase}${DEVICE_SELECT_PATH}?${query.toString()}`
}

/**
 * 轮询一次。还没在浏览器里确认时上游返回 404，这里翻译成 `{pending:true}`；
 * 拿到 token 时返回 `{account}`。
 */
export async function pollDeviceSession(session, { signal } = {}) {
  const region = regionOf(session.region)
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: 'S256',
  })
  const response = await request(`${region.openApiBase}${POLL_PATH}?${query.toString()}`, {
    method: 'GET',
    headers: baseHeaders(),
    timeoutMs: 20_000,
    signal,
  })
  if (response.status === 404 || response.status === 202) return { pending: true }
  if (!response.ok) {
    throw new HttpError(`Qoder 设备授权 HTTP ${response.status}`, { status: response.status, body: response.text.slice(0, 200) })
  }
  const payload = parseTokenPayload(response.json)
  if (payload.accessToken === '') return { pending: true }
  const info = await fetchUserInfo(payload.accessToken, region.id, { signal })
  const account = buildAccount({
    region,
    authKind: 'device',
    pat: '',
    tokens: {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: expiryFromPayload(payload),
    },
    machineId: session.machineId,
    info,
    payloadUid: payload.uid,
    payloadName: payload.userName,
  })
  return { pending: false, account }
}

/** 距到期不足 10 分钟就续期；先走 refresh，失败再用 PAT 重换。 */
export async function ensureFresh(account, { store, skewMs = 10 * 60_000, signal } = {}) {
  if (account === null || typeof account !== 'object') return account
  const expiresAt = Number(account.expiresAt ?? 0)
  if (expiresAt === 0 || expiresAt - Date.now() > skewMs) return account
  const patch = await refreshTokens(account, { signal })
  if (patch === null) return account
  return store !== undefined ? (store.update('qoder', account.id, patch) ?? { ...account, ...patch }) : { ...account, ...patch }
}

export async function refreshAccount(account, { store, signal } = {}) {
  const patch = await refreshTokens(account, { signal })
  if (patch === null) throw new HttpError('Qoder 账号续期失败，请重新登录')
  return store !== undefined ? (store.update('qoder', account.id, patch) ?? { ...account, ...patch }) : { ...account, ...patch }
}

async function refreshTokens(account, { signal } = {}) {
  const attempts = []
  if (account.authKind === 'device' || typeof account.jobRefreshToken === 'string') {
    attempts.push(() => refreshDeviceToken(account.jobRefreshToken, account.machineId, account.region, { signal }))
    attempts.push(() => refreshJobToken(account.jobRefreshToken, account.region, { signal }))
  }
  if (typeof account.pat === 'string' && account.pat !== '') {
    attempts.push(() => exchangeJobToken(account.pat, account.region, { signal }))
  }
  for (const attempt of attempts) {
    try {
      const tokens = await attempt()
      return { jobToken: tokens.accessToken, jobRefreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }
    } catch { /* 试下一条 */ }
  }
  return null
}

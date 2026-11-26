/**
 * TRAE 登录协议：浏览器授权 → 回调链接里带 refreshToken → ExchangeToken → GetUserInfo。
 *
 * 协议来源：
 *  - 玖念/traework2api Android 的 TraeAuthApi.kt（TRAE 国服实测）
 *  - dsh-get-it-for-free 渠道包的 trae-oauth.ts（国际服与手动回调）
 *
 * 不启动本地监听：授权页面跳转到 `127.0.0.1:18080/authorize` 会打不开，
 * 这是预期的；用户把地址栏里的完整链接粘回来即可。
 *
 * @module src/trae/auth.js
 */

import crypto from 'node:crypto'
import { HttpError, request, requestOk } from '../http.js'

export const CALLBACK_URL = 'http://127.0.0.1:18080/authorize'
export const DEFAULT_MODEL = 'DeepSeek-V4-Flash'

export const REGIONS = {
  cn: {
    id: 'cn',
    label: 'TRAE 国服（trae.cn）',
    consoleHost: 'https://www.trae.cn',
    oauthHost: 'https://api.trae.com.cn',
    agentHost: 'https://trae-api-cn.mchost.guru',
    clientId: 'en1oxy7wnw8j9n',
    pluginVersion: '2.3.62834',
    ideVersion: '0.1.52',
    ideVersionCode: '20260811',
    userRegion: 'CN',
  },
  sg: {
    id: 'sg',
    label: 'TRAE 国际服（trae.ai）',
    consoleHost: 'https://www.trae.ai',
    oauthHost: 'https://ug-normal.trae.ai',
    agentHost: 'https://core-normal.trae.ai',
    clientId: 'ono9krqynydwx5',
    pluginVersion: '2.3.62834',
    ideVersion: '0.1.52',
    ideVersionCode: '20260811',
    userRegion: '',
  },
}

export function regionOf(id) {
  return REGIONS[id] ?? REGIONS.cn
}

const EP_EXCHANGE = '/cloudide/api/v3/trae/oauth/ExchangeToken'
const EP_USER_INFO = '/cloudide/api/v3/trae/GetUserInfo'

function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

function traceId(machineId, deviceId) {
  const joined = machineId + deviceId
  return joined.length >= 16 ? joined.slice(-16) : joined.padStart(16, '0')
}

/** 构造 TRAE 登录页地址。machine / device 每次随机，只用于本次登录。 */
export function buildLoginUrl(regionId, { callbackUrl = CALLBACK_URL } = {}) {
  const region = regionOf(regionId)
  const machineId = hex(16)
  const deviceId = hex(16)
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: region.pluginVersion,
    auth_type: 'local',
    client_id: region.clientId,
    redirect: '0',
    login_trace_id: traceId(machineId, deviceId),
    auth_callback_url: callbackUrl,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: region.ideVersion,
    x_app_type: 'stable',
  })
  return `${region.consoleHost}/authorization?${params.toString()}`
}

function parseJsonParam(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  const candidates = [raw]
  try {
    const unescaped = decodeURIComponent(raw)
    if (unescaped !== raw) candidates.push(unescaped)
  } catch { /* 保留原值 */ }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* 继续 */ }
  }
  return undefined
}

function stringOf(source, key) {
  if (source === undefined) return ''
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function fixNickname(raw, uid) {
  if (raw === '') return uid === '' ? 'TRAE' : `用户${uid.slice(-4)}`
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8')
    if (fixed !== '' && !fixed.includes('\uFFFD')) return fixed
  } catch { /* 保留原值 */ }
  return raw
}

/**
 * 解析浏览器回调地址。
 * @returns {{refreshToken: string, accessToken: string, uid: string, nickname: string, enterpriseId: string, authCode: string}}
 */
export function parseCallbackUrl(rawUrl) {
  const text = String(rawUrl ?? '').trim()
  if (text === '') throw new HttpError('请先粘贴回调链接')
  let url
  try {
    url = new URL(text.startsWith('http') ? text : `http://127.0.0.1${text.startsWith('/') ? '' : '/'}${text}`)
  } catch {
    throw new HttpError('回调链接无法解析，请确认复制的是登录后跳转的完整地址')
  }
  const query = url.searchParams
  const userInfo = parseJsonParam(query.get('userInfo'))
  const userJwt = parseJsonParam(query.get('userJwt') ?? query.get('user_jwt'))
  const authCodeInfo = parseJsonParam(query.get('authCodeInfo'))
  const uid = stringOf(userInfo, 'UserID')
  const nickname = fixNickname(stringOf(userInfo, 'ScreenName'), uid)
  const enterpriseId = stringOf(userInfo, 'TenantID')
  let refreshToken = query.get('refreshToken') ?? query.get('refresh_token') ?? ''
  if (refreshToken === '') refreshToken = stringOf(userJwt, 'RefreshToken')
  const accessToken = refreshToken === '' ? stringOf(userJwt, 'Token') : ''
  const authCode = [
    query.get('code') ?? '',
    query.get('authCode') ?? '',
    stringOf(authCodeInfo, 'code'),
    stringOf(authCodeInfo, 'authCode'),
    query.get('authCodeInfo') ?? '',
  ].map(value => value.trim()).find(value => value !== '') ?? ''
  if (refreshToken === '' && accessToken === '' && authCode === '') {
    throw new HttpError('回调链接里没有 refreshToken；请确认复制的是登录成功后的跳转地址')
  }
  return { refreshToken, accessToken, uid, nickname, enterpriseId, authCode }
}

function normalizeExpiresAt(raw, fallbackSeconds) {
  const value = Number(raw)
  if (Number.isFinite(value) && value > 0) return value > 1e12 ? Math.round(value) : Math.round(value * 1000)
  const seconds = Number(fallbackSeconds)
  if (Number.isFinite(seconds) && seconds > 0) return Date.now() + Math.round(seconds * 1000)
  return 0
}

/** refreshToken → accessToken（refreshToken 轮换，返回新的那把）。 */
export async function exchangeToken(refreshToken, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new HttpError('缺少 refreshToken，无法续期')
  }
  const response = await request(`${region.oauthHost}${EP_EXCHANGE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': `Trae/${region.ideVersion}`,
    },
    body: JSON.stringify({ ClientID: region.clientId, RefreshToken: refreshToken, ClientSecret: '-', UserID: '' }),
    timeoutMs: 30_000,
    signal,
  })
  if (!response.ok) {
    throw new HttpError(`TRAE ExchangeToken HTTP ${response.status}`, {
      status: response.status,
      body: response.text.slice(0, 300),
    })
  }
  const result = response.json?.Result
  if (result === null || typeof result !== 'object') throw new HttpError('TRAE ExchangeToken 响应缺少 Result')
  const token = typeof result.Token === 'string' ? result.Token : ''
  if (token === '') throw new HttpError('TRAE ExchangeToken 未返回 Token')
  const nextRefresh = typeof result.RefreshToken === 'string' && result.RefreshToken !== '' ? result.RefreshToken : refreshToken
  return {
    accessToken: token,
    refreshToken: nextRefresh,
    expiresAt: normalizeExpiresAt(result.TokenExpireAt, result.TokenExpireDuration),
  }
}

export async function getUserInfo(accessToken, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  const response = await request(`${region.oauthHost}${EP_USER_INFO}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': `Trae/${region.ideVersion}`,
      'x-cloudide-token': accessToken,
    },
    body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: region.ideVersion }),
    timeoutMs: 30_000,
    signal,
  })
  if (!response.ok) {
    throw new HttpError(`TRAE GetUserInfo HTTP ${response.status}`, {
      status: response.status,
      body: response.text.slice(0, 300),
    })
  }
  const result = response.json?.Result ?? {}
  return {
    uid: typeof result.UserID === 'string' ? result.UserID : '',
    nickname: typeof result.ScreenName === 'string' ? result.ScreenName : '',
    enterpriseId: typeof result.EnterpriseID === 'string' ? result.EnterpriseID : '',
  }
}

/**
 * 粘贴回调链接完成登录。
 * @returns 账号对象（可直接写进 store）
 */
export async function loginWithCallback(callbackUrl, regionId, { signal } = {}) {
  const region = regionOf(regionId)
  const callback = parseCallbackUrl(callbackUrl)
  if (callback.authCode !== '' && callback.refreshToken === '') {
    throw new HttpError('上游返回的是 PKCE 授权码流程（code），当前实现尚未支持；请确认 TRAE 授权页是否切换了新流程')
  }
  let accessToken = callback.accessToken
  let refreshToken = callback.refreshToken
  let expiresAt = 0
  if (refreshToken !== '') {
    const exchanged = await exchangeToken(refreshToken, region.id, { signal })
    accessToken = exchanged.accessToken
    refreshToken = exchanged.refreshToken
    expiresAt = exchanged.expiresAt
  }
  if (accessToken === '') throw new HttpError('TRAE 换 token 后没有 accessToken')
  const info = await getUserInfo(accessToken, region.id, { signal })
  const uid = info.uid !== '' ? info.uid : callback.uid
  if (uid === '') throw new HttpError('TRAE 未能确定账号 uid（回调与 GetUserInfo 都为空）')
  return {
    id: `trae-${region.id}-${uid}`,
    uid,
    name: fixNickname(info.nickname !== '' ? info.nickname : callback.nickname, uid),
    region: region.id,
    accessToken,
    refreshToken,
    expiresAt,
    enterpriseId: info.enterpriseId !== '' ? info.enterpriseId : callback.enterpriseId,
  }
}

/** 距到期不足 10 分钟就续期；返回最新账号对象。 */
export async function ensureFresh(account, { store, skewMs = 10 * 60_000, signal } = {}) {
  if (account === null || typeof account !== 'object') return account
  const expiresAt = Number(account.expiresAt ?? 0)
  if (expiresAt === 0 || expiresAt - Date.now() > skewMs) return account
  if (typeof account.refreshToken !== 'string' || account.refreshToken === '') return account
  return refreshAccount(account, { store, signal })
}

export async function refreshAccount(account, { store, signal } = {}) {
  const exchanged = await exchangeToken(account.refreshToken, account.region, { signal })
  const patch = {
    accessToken: exchanged.accessToken,
    refreshToken: exchanged.refreshToken,
    expiresAt: exchanged.expiresAt,
  }
  const updated = store !== undefined ? store.update('trae', account.id, patch) : { ...account, ...patch }
  return updated ?? { ...account, ...patch }
}

/**
 * TRAE 积分查询 + 每日签到（国服 `api.trae.cn` 的 ug 接口）。
 *
 * 协议来源：玖念/traework2api 的 TraeUpstream.kt（`ug()` / `fetchUsage` / `fetchCheckin` /
 * `claimCheckin`），它又对齐了 luckymiaow/trae-mate 的 `checkin.rs`。
 *
 * 三个端点都是 `POST {}` + `Authorization: Cloud-IDE-JWT <token>`：
 *   - `/trae/api/v2/pay/ide_user_ent_usage`      当前可用积分
 *   - `/trae/api/v2/ug/checkin_credits/status`   今日签到状态
 *   - `/trae/api/v2/ug/checkin_credits/claim`    执行签到
 *
 * 签到**必须**带一整套按 uid 确定性派生的设备标识（x-device-id / vscode-sessionid /
 * x-market-user-id）：上游按设备维度限量，缺任一个都会判「操作太过频繁」(9074)。
 *
 * 国际服的 ug 协议未经实测，这里直接报「不支持」，不拿国际 token 去打国服 host。
 *
 * @module src/trae/credits.js
 */

import crypto from 'node:crypto'

import { HttpError, request } from '../http.js'
import { regionOf } from './auth.js'

const EP_USAGE = '/trae/api/v2/pay/ide_user_ent_usage'
const EP_CHECKIN_STATUS = '/trae/api/v2/ug/checkin_credits/status'
const EP_CHECKIN_CLAIM = '/trae/api/v2/ug/checkin_credits/claim'

/** 确定性字节流：反复取 SHA-256(`salt:seed` || 计数器大端 4 字节)，拼够 nbytes。 */
export function seededStream(seed, salt, nbytes) {
  const data = Buffer.from(`${salt}:${seed}`, 'utf8')
  const chunks = []
  let total = 0
  for (let i = 0; total < nbytes; i++) {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(i, 0)
    const digest = crypto.createHash('sha256').update(data).update(counter).digest()
    chunks.push(digest)
    total += digest.length
  }
  return Buffer.concat(chunks).subarray(0, nbytes)
}

/** `x-device-id`：15 位纯数字（不是 hex）。 */
export function deviceIdFor(uid) {
  const bytes = seededStream(String(uid ?? ''), 'devid', 16)
  let out = ''
  for (let i = 0; i < 15; i++) out += String(bytes[i] % 10)
  return out
}

/** `vscode-sessionid`：64 位 hex。 */
export function sessionIdFor(uid) {
  return seededStream(String(uid ?? ''), 'sess', 32).toString('hex').slice(0, 64)
}

/** `x-market-user-id`：标准 UUID v4（确定性派生，修正 version/variant 位）。 */
export function marketUserIdFor(uid) {
  const bytes = Buffer.from(seededStream(String(uid ?? ''), 'market', 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function ugHeaders(region, token, uid) {
  const headers = {
    authorization: `Cloud-IDE-JWT ${token}`,
    accept: '*/*',
    'content-type': 'application/json',
    'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    'x-market-client-id': 'VSCode 1.107.1',
    'x-market-user-id': marketUserIdFor(uid),
    'x-device-id': deviceIdFor(uid),
    'vscode-sessionid': sessionIdFor(uid),
    'x-lgw-req-sdk-type': '3',
    'package-type': 'stable_cn',
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': 'windows',
    'app-version': '0.1.45',
    'x-tt-trace-id': `00-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}-01`,
    'x-request-id': crypto.randomUUID(),
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'none',
  }
  if (typeof region.userRegion === 'string' && region.userRegion !== '') {
    headers['x-user-region'] = region.userRegion
  }
  return headers
}

async function ug(account, path, { signal } = {}) {
  const region = regionOf(account?.region)
  if (typeof region.ugHost !== 'string' || region.ugHost === '') {
    throw new HttpError('TRAE 国际服暂不支持积分/签到查询（协议未实测）', { status: 400 })
  }
  const token = account?.accessToken
  if (typeof token !== 'string' || token === '') {
    throw new HttpError('TRAE 账号没有 accessToken，请重新登录', { status: 401 })
  }
  const response = await request(`${region.ugHost}${path}`, {
    method: 'POST',
    headers: ugHeaders(region, token, account.uid),
    body: '{}',
    timeoutMs: 30_000,
    signal,
  })
  if (response.status === 401 || response.status === 403) {
    throw new HttpError('TRAE token 已失效，请重新登录', { status: 401, body: response.text.slice(0, 200) })
  }
  if (!response.ok) {
    throw new HttpError(`TRAE ${path} HTTP ${response.status}`, {
      status: response.status,
      body: response.text.slice(0, 200),
    })
  }
  const json = response.json
  if (json === null || typeof json !== 'object') throw new HttpError('TRAE 返回内容不是 JSON')
  // token 无效时上游回 200 + code=1001 + enable=false；那是鉴权失败，不是「没开放签到」。
  if (Number(json.code ?? 0) === 1001) {
    throw new HttpError('TRAE token 已失效，请重新登录', { status: 401, body: response.text.slice(0, 200) })
  }
  return json
}

/** `usage_summary` → 可用积分（total_amount − consumed_amount）。字段缺失返回 null。 */
export function parseCredits(root) {
  const summary = root?.usage_summary
  if (summary === null || typeof summary !== 'object') return null
  const total = Number(summary.total_amount)
  if (!Number.isFinite(total)) return null
  const consumed = Number(summary.consumed_amount ?? 0)
  const used = Number.isFinite(consumed) ? consumed : 0
  const remaining = Math.max(0, total - used)
  return { remaining, exceeded: remaining <= 0 }
}

/** 上游 status → `{checkedIn, credits, enable}`；鉴权失败（1001）返回 null。 */
export function parseCheckinStatus(root) {
  if (root === null || typeof root !== 'object') return null
  if (Number(root.code ?? 0) === 1001) return null
  return {
    checkedIn: root.checked_in === true,
    credits: Number.isFinite(Number(root.credits)) ? Number(root.credits) : 0,
    enable: root.enable === true,
  }
}

/** 本次签到是否真的刚签上：成功码 + 状态跃迁，缺一不可。 */
export function checkinSucceeded(before, after, code) {
  return code === 0 && after !== null && after.checkedIn === true && before?.checkedIn !== true
}

export async function fetchCredits(account, { signal } = {}) {
  const parsed = parseCredits(await ug(account, EP_USAGE, { signal }))
  if (parsed === null) throw new HttpError('TRAE 积分字段缺失')
  return parsed
}

export async function fetchCheckinStatus(account, { signal } = {}) {
  const status = parseCheckinStatus(await ug(account, EP_CHECKIN_STATUS, { signal }))
  if (status === null) throw new HttpError('TRAE 签到状态查询失败，请重新登录', { status: 401 })
  return status
}

export async function claimCheckin(account, { signal } = {}) {
  const root = await ug(account, EP_CHECKIN_CLAIM, { signal })
  return Number.isFinite(Number(root.code)) ? Number(root.code) : -1
}

/**
 * 单账号签到：查状态 → 未签则领 → 再查一次确认状态跃迁。
 * 返回 `{status, amount, message}`，status ∈ ok / already / unsupported / fail。
 */
export async function runCheckin(account, { signal } = {}) {
  const before = await fetchCheckinStatus(account, { signal })
  if (before.checkedIn) return { status: 'already', amount: 0, message: '今日已签到' }
  if (!before.enable) return { status: 'unsupported', amount: 0, message: '该账号未开放签到' }
  const code = await claimCheckin(account, { signal })
  const after = await fetchCheckinStatus(account, { signal })
  if (checkinSucceeded(before, after, code)) {
    return { status: 'ok', amount: after.credits, message: '' }
  }
  if (after.checkedIn) return { status: 'already', amount: 0, message: '今日已签到' }
  return { status: 'fail', amount: 0, message: `签到未生效（code=${code}）` }
}

/**
 * Qoder 积分查询 + 每日 Credits 领取。
 *
 * 协议来源：玖念/traework2api 的 QoderAuthApi.kt（`fetchCredits` / `loadCampaigns` / `claimOne`）。
 * 两者都是普通 Bearer 接口，**不需要 COSY 签名**（只有 `/algo/` 聊天网关要签）。
 *
 *   - `GET  {openApiBase}/api/v2/quota/usage`                      → 各类额度 remaining 之和
 *   - `GET  {openApiBase}/sash/api/v1/me/campaigns?forceRefresh=true` → 每日活动列表
 *   - `POST {openApiBase}/sash/api/v1/me/campaigns/{id}/claim`     → 领取（body `{}`，幂等）
 *
 * ⚠️ 活动列表能否下发取决于 `Cosy-ClientType: 10`（写成 5 会静默返回空列表）。
 * 缺桌面身份头时服务端也可能静默隐藏活动，所以拿到空列表时如实报「今日无可领活动」。
 *
 * @module src/qoder/credits.js
 */

import { HttpError, request } from '../http.js'
import { regionOf } from './auth.js'

const EP_USAGE = '/api/v2/quota/usage'
const EP_CAMPAIGNS = '/sash/api/v1/me/campaigns'
/** 决定活动列表能否下发；官方桌面端实测值。 */
const COSY_CLIENT_TYPE = '10'
const COSY_VERSION_MINIMAL = '1.0.1'

function minimalHeaders(jobToken, { json = false } = {}) {
  const headers = {
    authorization: `Bearer ${jobToken}`,
    accept: 'application/json',
    'user-agent': 'traework2api',
    'cosy-version': COSY_VERSION_MINIMAL,
    'cosy-clienttype': COSY_CLIENT_TYPE,
  }
  if (json) headers['content-type'] = 'application/json'
  return headers
}

function jobTokenOf(account) {
  const token = account?.jobToken
  if (typeof token !== 'string' || token === '') {
    throw new HttpError('Qoder 账号没有 jobToken，请重新登录', { status: 401 })
  }
  return token
}

async function callApi(account, path, { method = 'GET', body, signal } = {}) {
  const region = regionOf(account?.region)
  const response = await request(`${region.openApiBase}${path}`, {
    method,
    headers: minimalHeaders(jobTokenOf(account), { json: body !== undefined }),
    body: body === undefined ? undefined : body,
    timeoutMs: 30_000,
    signal,
  })
  if (response.status === 401 || response.status === 403) {
    throw new HttpError('Qoder token 已失效，请重新登录', { status: 401, body: response.text.slice(0, 200) })
  }
  if (!response.ok) {
    throw new HttpError(`Qoder ${path} HTTP ${response.status}`, {
      status: response.status,
      body: response.text.slice(0, 200),
    })
  }
  if (response.json === null || typeof response.json !== 'object') {
    throw new HttpError('Qoder 返回内容不是 JSON')
  }
  return response.json
}

/** 把个人 / 加购 / 组织额度逐项累加；内容裹在 data 下时解一层。 */
export function parseCredits(input) {
  let root = input
  const hasKnown = root !== null && typeof root === 'object'
    && ('userQuota' in root || 'personalQuota' in root || 'isQuotaExceeded' in root)
  if (!hasKnown && root !== null && typeof root === 'object' && root.data !== null && typeof root.data === 'object') {
    root = root.data
  }
  if (root === null || typeof root !== 'object') return null
  let remaining = 0
  for (const key of ['userQuota', 'personalQuota', 'addOnQuota', 'addonQuota', 'extraQuota']) {
    const quota = root[key]
    if (quota !== null && typeof quota === 'object') remaining += Number(quota.remaining ?? 0) || 0
  }
  for (const key of ['orgResourcePackage', 'organizationQuota']) {
    const quota = root[key]
    if (quota !== null && typeof quota === 'object' && quota.available !== false) {
      remaining += Number(quota.remaining ?? 0) || 0
    }
  }
  return { remaining: Math.max(0, remaining), exceeded: root.isQuotaExceeded === true }
}

/**
 * 活动列表解析。响应可能在根上，也可能裹在 `data` 下；活动 id 键名有三种写法。
 * 返回 `{ campaigns: [{id, claimStatus, actionType, benefitKind, benefitAmount, claimable, grantsCredits}], showCampaign }`。
 */
export function parseCampaigns(input) {
  let root = input
  if (root !== null && typeof root === 'object' && !('campaigns' in root)
    && root.data !== null && typeof root.data === 'object') {
    root = root.data
  }
  const showCampaign = root !== null && typeof root === 'object' && 'showCampaign' in root
    ? root.showCampaign === true
    : null
  const list = Array.isArray(root?.campaigns) ? root.campaigns : []
  const campaigns = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const id = String(item.campaignId ?? item.campaignKey ?? item.id ?? '').trim()
    if (id === '') continue
    const benefit = item.benefit !== null && typeof item.benefit === 'object' ? item.benefit : {}
    const amount = Number(benefit.amount ?? 0) || 0
    const claimStatus = String(item.claimStatus ?? '')
    campaigns.push({
      id,
      claimStatus,
      actionType: String(item.actionType ?? ''),
      benefitKind: String(benefit.kind ?? ''),
      benefitAmount: amount,
      claimable: claimStatus.toUpperCase() === 'CLAIMABLE',
      grantsCredits: amount > 0,
    })
  }
  return { campaigns, showCampaign }
}

/** claim 响应 → `{newly, amount, status}`。replayed=true 表示今天已领过，不算新领。 */
export function parseClaim(input) {
  let root = input
  if (root !== null && typeof root === 'object' && !root.status
    && root.data !== null && typeof root.data === 'object') {
    root = root.data
  }
  const status = String(root?.status ?? '')
  const replayed = root?.replayed === true
  const amount = Number(root?.benefit?.amount ?? 0) || 0
  const claimed = status.toUpperCase() === 'CLAIMED'
  return { newly: claimed && !replayed, amount: claimed && !replayed ? amount : 0, status }
}

export async function fetchCredits(account, { signal } = {}) {
  const parsed = parseCredits(await callApi(account, EP_USAGE, { signal }))
  if (parsed === null) throw new HttpError('Qoder 积分字段缺失')
  return parsed
}

export async function fetchCampaigns(account, { signal } = {}) {
  const root = await callApi(account, `${EP_CAMPAIGNS}?forceRefresh=true`, { signal })
  return parseCampaigns(root)
}

export async function claimCampaign(account, campaignId, { signal } = {}) {
  const root = await callApi(account, `${EP_CAMPAIGNS}/${encodeURIComponent(campaignId)}/claim`, {
    method: 'POST',
    body: '{}',
    signal,
  })
  return parseClaim(root)
}

function alreadyMessage(campaigns) {
  const creditCount = campaigns.filter(item => item.grantsCredits).length
  if (campaigns.length === 0) return '今日无可领活动（上游返回空列表）'
  if (creditCount > 0 && campaigns.every(item => item.claimStatus.toUpperCase() === 'CLAIMED')) {
    return `已领取 ${creditCount} 条`
  }
  if (creditCount === 0) return `无积分活动（${campaigns.length} 条均为查看类，不发 Credits）`
  return `无待领活动（${campaigns.length} 条均已处理）`
}

/**
 * 单账号领取：列活动 → 领所有 CLAIMABLE → 汇总。
 * 返回 `{status, amount, message}`，status ∈ ok / already / fail。
 */
export async function runCheckin(account, { signal } = {}) {
  const { campaigns } = await fetchCampaigns(account, { signal })
  const claimable = campaigns.filter(item => item.claimable)
  if (claimable.length === 0) return { status: 'already', amount: 0, message: alreadyMessage(campaigns) }

  let total = 0
  let fresh = 0
  let lastError = ''
  for (const campaign of claimable) {
    try {
      const result = await claimCampaign(account, campaign.id, { signal })
      if (result.newly) {
        total += result.amount
        fresh += 1
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (fresh > 0 && total > 0) return { status: 'ok', amount: total, message: '' }
  if (fresh > 0) return { status: 'ok', amount: 0, message: `领取 ${fresh} 条（无 Credits）` }
  return { status: 'already', amount: 0, message: lastError !== '' ? `领取未生效：${lastError}` : '今日已领取' }
}

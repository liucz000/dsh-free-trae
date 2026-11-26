/**
 * Qoder 积分查询 + 每日 Credits 领取。
 *
 * 协议来源：玖念/traework2api 的 QoderAuthApi.kt（`fetchCredits` / `loadCampaigns` / `claimOne`），
 * 签到判定参考 hulibuld/dsh-get-it-for-free 的 `src/qoder-checkin.js`。
 * 两者都是普通 Bearer 接口，**不需要 COSY 签名**（只有 `/algo/` 聊天网关要签）。
 *
 *   - `GET  {openApiBase}/api/v2/quota/usage`                       → 各类额度 remaining 之和
 *   - `GET  {openApiBase}/sash/api/v1/me/campaigns?forceRefresh=true` → 每日活动列表
 *   - `POST {openApiBase}/sash/api/v1/me/campaigns/{id}/claim`      → 领取（幂等）
 *   - `GET  {openApiBase}/sash/api/v2/me/usage`                     → 无活动时区分「没开通/无资格」
 *
 * ⚠️ 活动列表能否下发取决于 `Cosy-ClientType: 10`（写成 5 会静默返回空列表）。
 * 缺桌面身份头时服务端也可能静默隐藏活动，所以拿到空列表时如实报原因，不当作「已签」。
 *
 * 判定规则（与参考实现一致）：
 *   - 只有 `actionType === 'CLAIM_BENEFIT'` 才算签到活动；
 *   - `CLAIMED` 且 `endAt` 未过期才算「今天已签」，避免把上一轮当成今天；
 *   - UTC+8 10:00 前活动尚未刷新，空列表报「待刷新」而不是失败；
 *   - 无活动时用 usage 区分体验版无资格 / 未开通 / 今天没有活动；
 *   - claim 回 `BLOCKED` 之类不等于失败：隔 1.2 秒重看列表，已变 CLAIMED 就按成功记。
 *
 * @module src/qoder/credits.js
 */

import { HttpError, request } from '../http.js'
import { regionOf } from './auth.js'

const EP_USAGE = '/api/v2/quota/usage'
const EP_ME_USAGE = '/sash/api/v2/me/usage'
const EP_CAMPAIGNS = '/sash/api/v1/me/campaigns'
/** 决定活动列表能否下发；官方桌面端实测值。 */
const COSY_CLIENT_TYPE = '10'
const COSY_VERSION_MINIMAL = '1.0.1'
/** 每日活动在 UTC+8 10:00 刷新，之前看到的是昨天那一轮。 */
const REFRESH_HOUR_UTC8 = 10
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000
const CONFIRM_DELAY_MS = 1_200
const INELIGIBLE_MESSAGE = '体验版（免费）账号自 2026-11-19 起不再开放每日领取；开通试用/专业版/会员卡后可领，重试不会改变结果'
const NOT_ACTIVATED_MESSAGE = '该账号尚未在 Qoder 侧开通每日领取，请先用官方客户端登录一次'

function minimalHeaders(jobToken, { json = false } = {}) {
  const headers = {
    authorization: `Bearer ${jobToken}`,
    accept: 'application/json',
    'user-agent': 'Qoder',
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
      endAt: Number(item.endAt ?? 0) || 0,
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

/** 今天的活动是否已刷新（UTC+8 10:00）。 */
export function campaignsRefreshedToday(now = Date.now()) {
  return new Date(now + UTC8_OFFSET_MS).getUTCHours() >= REFRESH_HOUR_UTC8
}

/** 活动列表里没有每日活动时，用 usage 区分「体验版无资格 / 没开通 / 今天没活动」。 */
async function fetchMeUsage(account, { signal } = {}) {
  try {
    const root = await callApi(account, EP_ME_USAGE, { signal })
    const usage = root?.qoderUsage
    if (usage === null || typeof usage !== 'object') return null
    return {
      userType: String(usage.userType ?? ''),
      hasAddOnQuota: usage.addOnQuota !== undefined && usage.addOnQuota !== null,
    }
  } catch {
    return null
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function alreadyMessage(benefits) {
  const creditCount = benefits.filter(item => item.grantsCredits).length
  if (benefits.length === 0) return '今日没有可领取的每日活动'
  if (creditCount > 0 && benefits.every(item => item.claimStatus.toUpperCase() === 'CLAIMED')) {
    return `已领取 ${creditCount} 条`
  }
  return '无待领活动（均已处理）'
}

/**
 * 领一条并确认。
 * `BLOCKED` 不代表领不到——服务端常常已经登记，只是当次响应没下发；隔一下重看列表。
 */
async function claimAndConfirm(account, campaign, { signal } = {}) {
  const result = await claimCampaign(account, campaign.id, { signal })
  if (result.status.toUpperCase() === 'CLAIMED') {
    if (result.newly) {
      return {
        status: 'claimed',
        amount: result.amount > 0 ? result.amount : campaign.benefitAmount,
      }
    }
    return { status: 'already', amount: campaign.benefitAmount }
  }
  await delay(CONFIRM_DELAY_MS)
  const { campaigns } = await fetchCampaigns(account, { signal })
  const row = campaigns.find(item => item.id === campaign.id)
  if (row !== undefined && row.claimStatus.toUpperCase() === 'CLAIMED') {
    return {
      status: 'claimed',
      amount: row.benefitAmount > 0 ? row.benefitAmount : campaign.benefitAmount,
    }
  }
  return {
    status: 'fail',
    message: `领取未完成（status=${result.status || '未知'}），服务端没当场下发积分`,
  }
}

/**
 * 单账号领取：列活动 → 领所有可领的 CLAIM_BENEFIT → 汇总。
 * 返回 `{status, amount, message}`，status ∈ ok / already / pending / ineligible / fail。
 */
export async function runCheckin(account, { signal, now = Date.now() } = {}) {
  const { campaigns } = await fetchCampaigns(account, { signal })
  const benefits = campaigns.filter(item => item.actionType === 'CLAIM_BENEFIT')

  const today = benefits.find(item =>
    item.claimStatus.toUpperCase() === 'CLAIMED' && item.endAt * 1000 > now)
  if (today !== undefined) {
    return {
      status: 'already',
      amount: today.benefitAmount,
      message: today.benefitAmount > 0 ? `今日已领取 +${today.benefitAmount}` : '今日已领取',
    }
  }

  const claimable = benefits.filter(item =>
    item.claimStatus.toUpperCase() === 'CLAIMABLE' && (item.endAt === 0 || item.endAt * 1000 > now))
  if (claimable.length === 0) {
    if (benefits.length === 0) {
      if (!campaignsRefreshedToday(now)) {
        return { status: 'pending', amount: 0, message: '今天这一轮还没刷新（UTC+8 10:00 刷新），稍后再试' }
      }
      const usage = await fetchMeUsage(account, { signal })
      if (usage !== null && usage.userType === 'personal_standard') {
        return { status: 'ineligible', amount: 0, message: INELIGIBLE_MESSAGE }
      }
      if (usage !== null && usage.hasAddOnQuota === false) {
        return { status: 'pending', amount: 0, message: NOT_ACTIVATED_MESSAGE }
      }
    }
    return { status: 'already', amount: 0, message: alreadyMessage(benefits) }
  }

  let total = 0
  let fresh = 0
  let alreadyAmount = 0
  let lastError = ''
  for (const campaign of claimable) {
    try {
      const result = await claimAndConfirm(account, campaign, { signal })
      if (result.status === 'claimed') {
        total += result.amount
        fresh += 1
      } else if (result.status === 'already') {
        alreadyAmount += result.amount
      } else {
        lastError = result.message ?? '领取失败'
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (fresh > 0 && total > 0) return { status: 'ok', amount: total, message: '' }
  if (fresh > 0) return { status: 'ok', amount: 0, message: `领取 ${fresh} 条（无 Credits）` }
  if (alreadyAmount > 0) return { status: 'already', amount: alreadyAmount, message: '今日已领取' }
  return { status: 'fail', amount: 0, message: lastError !== '' ? lastError : '领取未生效' }
}

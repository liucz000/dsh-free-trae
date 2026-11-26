/**
 * Qoder 模型目录。
 *
 * 内置清单来自 玖念/traework2api 的 QoderModelCatalog.BUILTIN（catalog-v6 官方快照），
 * key 是请求里 `model_config.key` 的真值，不能自己编。
 *
 * 另外支持用 COSY 签名拉一次 `/algo/api/v2/model/list` 覆盖内置清单；
 * 拉不到就继续用内置清单（绝不因为网络失败把目录清空）。
 *
 * @module src/qoder/models.js
 */

import { HttpError, request } from '../http.js'
import { regionOf, machineOS } from './auth.js'
import {
  COSY_VERSION,
  MODEL_LIST_SIGNED_PATH,
  NATIVE_MODEL_LIST_PATH,
  authorization,
  authorizationPayload,
  generateRuntimeFields,
  newRequestId,
} from './cosy.js'

export const DEFAULT_KEY = 'auto'
const CACHE_MS = 10 * 60_000

/** 顺序即 UI 顺序；首项为默认。 */
export const BUILTIN = [
  { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', contextWindow: 180_000, reasoning: false, priceFactor: null },
  { id: 'auto', name: 'Auto', contextWindow: 180_000, reasoning: false, priceFactor: 0.5 },
  { id: 'ultimate', name: '极致', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.8, aliases: ['Ultimate'] },
  { id: 'performance', name: '快速', contextWindow: 1_000_000, reasoning: false, priceFactor: null, aliases: ['Performance'] },
  { id: 'efficient', name: '经济', contextWindow: 180_000, reasoning: false, priceFactor: null, aliases: ['Efficient'] },
  { id: 'smodel', name: 'Sonus', contextWindow: 180_000, reasoning: true, priceFactor: 8.0 },
  { id: 'cmodel', name: 'Cantus', contextWindow: 200_000, reasoning: true, priceFactor: 4.0 },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max 2', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.5, aliases: ['Qwen3.8-Max'] },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.0, aliases: ['Qwen3.8-Flash-1M'] },
  { id: 'kmodel_latest', name: 'Kimi-K3.1-Pro', contextWindow: 1_000_000, reasoning: false, priceFactor: 1.0, aliases: ['Kimi-K3'] },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 256_000, reasoning: true, priceFactor: 0.8, aliases: ['Kimi-K2.7-Code'] },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.8 },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.1 },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.5 },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.0, aliases: ['DeepSeek-V4-Flash'] },
  { id: 'mmodel', name: 'MiniMax-M3.1-Flash', contextWindow: 1_000_000, reasoning: false, priceFactor: 0.1, aliases: ['MiniMax-M3'] },
  { id: 'lite', name: 'Lite', contextWindow: 180_000, reasoning: false, priceFactor: null },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.1 },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.04 },
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.1 },
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 1_000_000, reasoning: true, priceFactor: 0.6 },
]

const dynamic = new Map()

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase()
}

function withDefaults(entry) {
  return {
    ...entry,
    maxOutput: Math.min(32_000, entry.contextWindow),
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
  }
}

/** 把客户端传的 id / 展示名 / 别名统一解析成目录项。 */
export function resolveModel(value) {
  const raw = String(value ?? '').trim()
  const oneM = raw.toLowerCase().endsWith('[1m]')
  const base = oneM ? raw.slice(0, -4).trim() : raw
  const key = normalizeKey(base)
  const catalog = currentCatalog()
  let hit = catalog.find(entry => normalizeKey(entry.id) === key)
  if (hit === undefined) hit = catalog.find(entry => normalizeKey(entry.name) === key)
  if (hit === undefined) hit = catalog.find(entry => entry.aliases.some(alias => normalizeKey(alias) === key))
  if (hit === undefined) {
    hit = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(base) && base !== ''
      ? { id: base, name: base, contextWindow: 180_000, reasoning: false, priceFactor: null, aliases: [] }
      : catalog.find(entry => entry.id === DEFAULT_KEY)
  }
  if (oneM && hit.contextWindow < 900_000) {
    const ultimate = catalog.find(entry => entry.id === 'ultimate')
    if (ultimate !== undefined) hit = ultimate
  }
  return withDefaults(hit)
}

export function currentCatalog() {
  for (const rows of dynamic.values()) {
    if (rows.length > 0) return rows
  }
  return BUILTIN.map(withDefaults)
}

function collectModelRows(node, out, depth = 0) {
  if (depth > 4 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) {
      const row = toCatalogEntry(item)
      if (row !== null) out.push(row)
      else collectModelRows(item, out, depth + 1)
    }
    return
  }
  for (const value of Object.values(node)) collectModelRows(value, out, depth + 1)
}

function toCatalogEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.key ?? value.model_key ?? '').trim()
  if (id === '') return null
  if (value.enable === false || value.enable === 0) return null
  // 只接受带模型字段的对象，避免把上游目录里同层的功能开关当成模型。
  const looksLikeModel = value.price_factor !== undefined
    || value.max_input_tokens !== undefined
    || value.context_config !== undefined
    || value.is_reasoning !== undefined
  if (!looksLikeModel) return null
  const name = String(value.display_name ?? value.name ?? '').trim() || id
  let contextWindow = Number(value.max_input_tokens ?? 0)
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    const config = value.context_config
    if (config !== null && typeof config === 'object') {
      for (const item of Object.values(config)) {
        const count = Number(item?.token_count ?? 0)
        if (Number.isFinite(count) && count > contextWindow) contextWindow = count
      }
    }
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) contextWindow = 180_000
  const priceFactor = value.price_factor === undefined || value.price_factor === null || Number.isNaN(Number(value.price_factor))
    ? null
    : Number(value.price_factor)
  return withDefaults({
    id,
    name,
    contextWindow,
    reasoning: value.is_reasoning === true,
    priceFactor,
    originalPriceFactor: originalPriceFactorOf(value),
  })
}

/**
 * 上游若带原价（不同版本/渠道字段名不一），读出来给展示层画 `×原价→×现价`。
 * 读不到返回 null —— 不猜原价。
 */
function originalPriceFactorOf(value) {
  for (const raw of [
    value.original_price_factor,
    value.before_price_factor,
    value.promotion?.beforePromotionPriceFactor,
  ]) {
    if (raw === undefined || raw === null) continue
    const number = Number(raw)
    if (Number.isFinite(number) && number >= 0) return number
  }
  return null
}

export function parseCatalog(text) {
  let root
  try {
    root = JSON.parse(text)
  } catch {
    return []
  }
  const out = []
  const seen = new Set()
  collectModelRows(root, out)
  const unique = out.filter(row => (seen.has(row.id) ? false : (seen.add(row.id), true)))
  return unique
}

export async function fetchCatalog(account, { signal, force = false } = {}) {
  if (account === null || typeof account !== 'object') return BUILTIN.map(withDefaults)
  const key = `${account.uid}|${account.jobToken}`
  const hit = dynamic.get(key)
  if (!force && hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.models
  if (typeof account.jobToken !== 'string' || account.jobToken === '') {
    return hit?.models ?? BUILTIN.map(withDefaults)
  }
  try {
    const region = regionOf(account.region)
    const runtime = generateRuntimeFields({
      uid: account.uid,
      jobToken: account.jobToken,
      organizationId: account.organizationId,
      organizationTags: account.organizationTags,
      dataPolicyAgreed: account.dataPolicyAgreed,
    })
    const unixSeconds = String(Math.floor(Date.now() / 1000))
    const payload = authorizationPayload(newRequestId(), runtime.encryptUserInfo)
    const headers = {
      accept: 'application/json',
      authorization: authorization(payload, runtime.key, unixSeconds, '', MODEL_LIST_SIGNED_PATH),
      'content-type': 'application/json',
      'cosy-business-product': 'cli',
      'cosy-business-type': 'agent',
      'cosy-clienttype': '5',
      'cosy-data-policy': account.dataPolicyAgreed === true ? 'agree' : 'disagree',
      'cosy-date': unixSeconds,
      'cosy-key': runtime.key,
      'cosy-machineid': account.machineId ?? '',
      'cosy-machineos': machineOS(),
      'cosy-scene': 'assistant',
      'cosy-user': account.uid,
      'cosy-version': COSY_VERSION,
      'login-version': 'v2',
    }
    if (typeof account.organizationId === 'string' && account.organizationId !== '') {
      headers['cosy-organization-id'] = account.organizationId
    }
    if (Array.isArray(account.organizationTags) && account.organizationTags.length > 0) {
      headers['cosy-organization-tags'] = account.organizationTags.join(',')
    }
    const response = await request(`${region.inferBase}${NATIVE_MODEL_LIST_PATH}`, {
      method: 'GET',
      headers,
      timeoutMs: 30_000,
      signal,
    })
    if (!response.ok) throw new HttpError(`Qoder 模型目录 HTTP ${response.status}`, { status: response.status })
    const models = parseCatalog(response.text)
    if (models.length === 0) throw new HttpError('Qoder 模型目录为空')
    dynamic.set(key, { at: Date.now(), models })
    return models
  } catch {
    return hit?.models ?? BUILTIN.map(withDefaults)
  }
}

export function clearCatalogCache() {
  dynamic.clear()
}

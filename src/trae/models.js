/**
 * TRAE 模型目录：POST /api/ide/v1/get_detail_param。
 *
 * 只保留「官方内置、能直接聊天」的条目（判据与 traework2api 的 isChatModel 一致）：
 * config_source==1、display_config.is_custom_model==false、is_invisible_to_user==false，
 * 且名字不是内部 agent（summary / *_agent / custom_model_* 等）。
 *
 * @module src/trae/models.js
 */

import { request, HttpError } from '../http.js'
import { regionOf } from './auth.js'

const EP_MODELS = '/api/ide/v1/get_detail_param'
const FUNCTION = 'solo_work_remote'
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
const DEVICE_BRAND = '83DG'
const OS_VERSION = 'Windows 11 Pro'
const CACHE_MS = 10 * 60_000

/** 拉不到目录时的兜底：不覆盖用户已有的清单，只在首次登录时可见。 */
export const FALLBACK_MODELS = [
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 131_072, maxOutput: 32_768 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 131_072, maxOutput: 32_768 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 131_072, maxOutput: 32_768 },
  { id: 'step-5-preview', name: 'Step-5 Preview', contextWindow: 131_072, maxOutput: 32_768 },
]

/**
 * 官方文档《内置模型限时折扣》公布的「积分消耗速度」（倍，折扣前的基础值）。
 *
 * 上游 `get_detail_param` **不返回**价格字段，所以只能以官方文档为准：
 * 只收录文档明确写出的模型，其余保持未知（不显示标签），绝不默认成 1.0。
 * 这些值会随会员档位、忙时/闲时和限时活动变化，仅作选择模型时的相对参考。
 */
export const PRICE_FACTORS = Object.freeze({
  'seed-2.1-turbo': 0.4,
  'seed-code': 0.12,
  'deepseek-v4.1-flash': 0.12,
  'deepseek-v4-pro': 0.72,
  'glm-5.3': 0.78,
})

/** 模型 id → 官方积分消耗速度；文档没公布返回 null。 */
export function priceFactorFor(id) {
  const key = String(id ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(PRICE_FACTORS, key) ? PRICE_FACTORS[key] : null
}

const cache = new Map()

export function soloHeaders(region, token, uid, { stream = false } = {}) {
  const headers = {
    accept: stream ? 'text/event-stream' : 'application/json',
    'content-type': 'application/json',
    'user-agent': `Trae/${region.ideVersion}`,
    authorization: `Cloud-IDE-JWT ${token}`,
    'x-cloudide-token': token,
    'x-ide-token': token,
    'x-app-id': APP_ID,
    'x-app-version': 'default',
    'x-ide-version': region.ideVersion,
    'x-ide-version-code': region.ideVersionCode,
    'x-app-version-code': region.ideVersionCode,
    'x-ide-version-type': 'stable',
    'x-device-type': 'windows',
    'x-os-version': OS_VERSION,
    'x-device-brand': DEVICE_BRAND,
    'request-traffic-type': 'prod',
  }
  if (typeof uid === 'string' && uid !== '') headers['x-uid'] = uid
  return headers
}

function isBuiltinChatName(id) {
  const lower = id.toLowerCase()
  if (lower.startsWith('custom_model')) return false
  const blocked = ['agent', 'subagent', 'summary', 'sagitta', 'aquila', 'file_search', 'explore_', 'computer_use', 'browser_use']
  return blocked.every(word => !lower.includes(word))
}

function isChatModel(entry) {
  if (Number(entry?.config_source ?? 0) !== 1) return false
  const display = entry?.display_config
  if (display === null || typeof display !== 'object') return false
  if (display.is_custom_model === true) return false
  if (entry.is_invisible_to_user === true) return false
  return isBuiltinChatName(String(entry.config_name ?? '').trim())
}

export function parseModels(root) {
  const list = Array.isArray(root?.config_info_list) ? root.config_info_list : []
  const out = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = String(entry.config_name ?? '').trim()
    if (id === '' || !isChatModel(entry)) continue
    const name = String(entry.display_config?.display_name ?? '').trim() || id
    const detail = Array.isArray(entry.model_detail_list) ? entry.model_detail_list[0] : undefined
    let contextWindow = Number(detail?.max_input_tokens ?? 0)
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) contextWindow = 131_072
    out.push({
      id,
      name,
      contextWindow,
      maxOutput: Math.min(32_768, contextWindow),
      priceFactor: priceFactorFor(id),
    })
  }
  return out
}

export async function fetchModels(account, { signal, force = false } = {}) {
  const key = `${account.uid}|${account.region}`
  const hit = cache.get(key)
  if (!force && hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.models
  if (typeof account.accessToken !== 'string' || account.accessToken === '') return hit?.models ?? FALLBACK_MODELS
  const region = regionOf(account.region)
  const body = JSON.stringify({
    function: FUNCTION,
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null,
  })
  try {
    const response = await request(`${region.agentHost}${EP_MODELS}`, {
      method: 'POST',
      headers: soloHeaders(region, account.accessToken, account.uid, { stream: false }),
      body,
      timeoutMs: 30_000,
      signal,
    })
    if (!response.ok) throw new HttpError(`TRAE 模型目录 HTTP ${response.status}`, { status: response.status, body: response.text.slice(0, 200) })
    const models = parseModels(response.json)
    if (models.length === 0) throw new HttpError('TRAE 模型目录为空')
    cache.set(key, { at: Date.now(), models })
    return models
  } catch (error) {
    if (hit !== undefined) return hit.models
    throw error
  }
}

/** 登录/退出后清缓存，避免拿旧账号的目录。 */
export function clearModelCache() {
  cache.clear()
}

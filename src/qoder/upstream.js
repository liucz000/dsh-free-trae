/**
 * Qoder 聊天上游：COSY 签名 + `/algo/.../agent_chat_generation` + 信封 SSE。
 *
 * 协议来源：玖念/traework2api 的 QoderUpstream.kt，逐条对齐：
 *  - 请求体包成 business / chat_task / model_config / messages / parameters；
 *  - 整体过自定义 base64 + 首尾三分之一对调；
 *  - 头里带 Authorization(COSY)、Cosy-Date/Key/MachineId/User/Scene…；
 *  - 上游 SSE 每帧是 `{statusCodeValue, body}`，真正的 OpenAI chunk 在 body 字符串里；
 *  - 上游并行工具调用都发 index=0，这里按新 id 重排。
 *
 * @module src/qoder/upstream.js
 */

import { HttpError, readSse, streamFetch } from '../http.js'
import { machineOS, regionOf } from './auth.js'
import {
  COSY_VERSION,
  COSY_SIGNED_PATH,
  NATIVE_INFER_PATH,
  NATIVE_INFER_QUERY,
  authorization,
  authorizationPayload,
  encodeBody,
  generateRuntimeFields,
  newRequestId,
  sessionIdFor,
} from './cosy.js'
import { DEFAULT_KEY, resolveModel } from './models.js'

const DEFAULT_MAX_TOKENS = 32_000
const MAX_ATTEMPTS = 3

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(text => text !== '')
    .join('\n')
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = textOfContent(message.content)
    if (text !== '') return text
  }
  return ''
}

function toUpMessage(message) {
  const role = String(message.role ?? '')
  const out = { role }
  if (typeof message.name === 'string' && message.name !== '') out.name = message.name
  if (typeof message.tool_call_id === 'string' && message.tool_call_id !== '') out.tool_call_id = message.tool_call_id
  const content = message.content
  if (typeof content === 'string' && content !== '' && role !== 'tool') {
    out.contents = [{ type: 'text', text: content }]
  }
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  if (calls.length > 0) {
    out.tool_calls = calls
    out.content = typeof content === 'string' ? content : ''
  } else if (content !== undefined && content !== null) {
    out.content = content
  }
  return out
}

/** 保证恰好一个 ephemeral 缓存标记。 */
function ensureCacheMarker(messages) {
  for (const message of messages) {
    for (const part of message.contents ?? []) {
      if (part.cache_control !== undefined) return
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'tool') continue
    const parts = message.contents ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const type = parts[j].type
      if (type === 'text' || type === 'image_url') {
        parts[j].cache_control = { type: 'ephemeral' }
        return
      }
    }
  }
}

function normalizeEffort(effort) {
  if (typeof effort !== 'string' || effort === '') return undefined
  if (effort === 'minimal') return 'low'
  return ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : undefined
}

function stopList(raw) {
  if (typeof raw === 'string') return raw === '' ? undefined : [raw]
  if (Array.isArray(raw)) return raw.length === 0 ? undefined : raw
  return undefined
}

function parametersOf(raw) {
  const out = {}
  const max = Number(raw.max_completion_tokens ?? 0) > 0
    ? Number(raw.max_completion_tokens)
    : (Number(raw.max_tokens ?? 0) > 0 ? Number(raw.max_tokens) : DEFAULT_MAX_TOKENS)
  out.max_tokens = max
  const effort = normalizeEffort(raw.reasoning_effort)
  if (effort !== undefined) out.reasoning_effort = effort
  if (Number.isFinite(Number(raw.temperature)) && raw.temperature !== undefined && raw.temperature !== null) {
    out.temperature = Number(raw.temperature)
  }
  if (Number.isFinite(Number(raw.top_p)) && raw.top_p !== undefined && raw.top_p !== null) out.top_p = Number(raw.top_p)
  const stop = stopList(raw.stop)
  if (stop !== undefined) out.stop = stop
  if (raw.tool_choice !== undefined && raw.tool_choice !== null) out.tool_choice = raw.tool_choice
  return out
}

/**
 * OpenAI 请求体 → Qoder upstream body。
 * @param {object} raw
 * @param {object} account
 */
export function prepareBody(raw, account) {
  const source = raw ?? {}
  const resolved = resolveModel(source.model)
  const systemParts = []
  const messages = []
  for (const message of source.messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOfContent(message.content)
      if (text !== '') systemParts.push(text)
      continue
    }
    messages.push(toUpMessage(message))
  }
  ensureCacheMarker(messages)
  const requestId = newRequestId()
  const modelKey = resolved.id
  return {
    business: {
      product: 'cli',
      version: COSY_VERSION,
      type: 'agent',
      id: newRequestId(),
      name: lastUserText(messages).slice(0, 10),
      begin_at: Date.now(),
      stage: 'start',
    },
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: sessionIdFor(`${account?.uid ?? ''}|${modelKey}`),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {},
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: modelKey,
      format: 'openai',
      source: 'system',
      enable: true,
      display_name: resolved.name,
      model: '',
      is_vl: true,
      is_reasoning: resolved.reasoning === true,
      api_key: '',
      url: '',
      price_factor: resolved.priceFactor ?? 1.0,
      max_input_tokens: resolved.contextWindow,
    },
    custom_model: null,
    system: systemParts.join('\n\n'),
    messages,
    tools: Array.isArray(source.tools) ? source.tools : [],
    parameters: parametersOf(source),
    model: modelKey,
    __resolved: resolved,
  }
}

const runtimeCache = new Map()

function runtimeFor(account, jobToken) {
  const key = `${account.uid}|${jobToken}`
  const hit = runtimeCache.get(key)
  if (hit !== undefined) return hit
  if (runtimeCache.size > 8) runtimeCache.clear()
  const fields = generateRuntimeFields({
    uid: account.uid,
    jobToken,
    organizationId: account.organizationId,
    organizationTags: account.organizationTags,
    dataPolicyAgreed: account.dataPolicyAgreed,
  })
  runtimeCache.set(key, fields)
  return fields
}

function inferHeaders(account, authorizationValue, cosyKey, unixSeconds, modelKey) {
  const headers = {
    accept: 'text/event-stream',
    authorization: authorizationValue,
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'cosy-business-product': 'cli',
    'cosy-business-type': 'agent',
    'cosy-clienttype': '5',
    'cosy-data-policy': account.dataPolicyAgreed === true ? 'agree' : 'disagree',
    'cosy-date': unixSeconds,
    'cosy-key': cosyKey,
    'cosy-machineid': account.machineId ?? '',
    'cosy-machineos': machineOS(),
    'cosy-scene': 'assistant',
    'cosy-user': account.uid,
    'cosy-version': COSY_VERSION,
    'login-version': 'v2',
    'x-model-key': modelKey,
    'x-model-source': 'system',
  }
  if (typeof account.organizationId === 'string' && account.organizationId !== '') {
    headers['cosy-organization-id'] = account.organizationId
  }
  if (Array.isArray(account.organizationTags) && account.organizationTags.length > 0) {
    headers['cosy-organization-tags'] = account.organizationTags.join(',')
  }
  return headers
}

function toolFragments(delta, indexer) {
  const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
  const out = []
  for (const call of calls) {
    if (call === null || typeof call !== 'object') continue
    const id = typeof call.id === 'string' ? call.id : ''
    let index = Number.isInteger(call.index) ? call.index : 0
    if (id !== '') {
      if (indexer.seen) indexer.cur += 1
      else indexer.seen = true
      index = indexer.cur
    } else {
      index = indexer.cur
    }
    const fn = call.function ?? {}
    out.push({
      index,
      id,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
    })
  }
  return out
}

function looksQueued(text) {
  return text.includes('RESOURCE_LIMIT') || text.includes('"code":"10605"') || text.includes('10605') || text.includes('"isQueued":true')
}

/**
 * 发一次 Qoder 聊天并逐帧产出增量。
 * @param {{body: object, account: object, signal?: AbortSignal, jobToken?: string}} options
 */
export async function * chatDeltas({ body, account, signal, jobToken }) {
  const region = regionOf(account.region)
  const token = typeof jobToken === 'string' && jobToken !== '' ? jobToken : account.jobToken
  if (typeof token !== 'string' || token === '') throw new HttpError('Qoder 账号没有 jobToken，请重新登录')
  const resolved = body.__resolved ?? resolveModel(body.model ?? body.model_config?.key ?? DEFAULT_KEY)
  const modelKey = body.model_config?.key ?? resolved.id
  const { __resolved, ...wireBody } = body
  const encoded = encodeBody(Buffer.from(JSON.stringify(wireBody), 'utf8'))
  const encodedText = encoded.toString('ascii')

  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const unixSeconds = String(Math.floor(Date.now() / 1000))
    const runtime = runtimeFor(account, token)
    const payload = authorizationPayload(newRequestId(), runtime.encryptUserInfo)
    const auth = authorization(payload, runtime.key, unixSeconds, encodedText, COSY_SIGNED_PATH)
    const stream = await streamFetch(`${region.inferBase}${NATIVE_INFER_PATH}${NATIVE_INFER_QUERY}`, {
      method: 'POST',
      headers: inferHeaders(account, auth, runtime.key, unixSeconds, modelKey),
      body: encoded,
      signal,
    })
    try {
      if (!stream.response.ok) {
        const text = await stream.response.text().catch(() => '')
        lastError = new HttpError(
          looksQueued(text)
            ? `Qoder 模型「${modelKey}」当前排队/资源受限，请换模型或换账号`
            : `Qoder 上游 HTTP ${stream.response.status}: ${text.slice(0, 200)}`,
          { status: stream.response.status, body: text.slice(0, 400) },
        )
        if (stream.response.status === 401 || (!looksQueued(text) && stream.response.status < 500 && stream.response.status !== 408 && stream.response.status !== 429)) {
          throw lastError
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * 2 ** (attempt - 1))))
          continue
        }
        throw lastError
      }
      let sawFinish = false
      const indexer = { cur: 0, seen: false }
      for await (const frame of readSse(stream.response)) {
        stream.touch()
        const event = frame.event
        const payloadText = frame.data.trim()
        if (payloadText === '') continue
        if (event === 'finish') { sawFinish = true; break }
        let envelope
        try {
          envelope = JSON.parse(payloadText)
        } catch {
          continue
        }
        const status = Number(envelope.statusCodeValue ?? 0)
        const envelopeBody = typeof envelope.body === 'string' ? envelope.body : ''
        if (status !== 0 && status !== 200) {
          let message = ''
          try { message = JSON.parse(envelopeBody)?.message ?? '' } catch { /* 忽略 */ }
          throw new Error(message !== '' ? message : `Qoder upstream status ${status}`)
        }
        if (envelopeBody === '') continue
        let chunk
        try {
          chunk = JSON.parse(envelopeBody)
        } catch {
          continue
        }
        if (chunk?.error !== undefined && chunk.error !== null) {
          throw new Error(String(chunk.error.message ?? 'Qoder upstream error'))
        }
        if (chunk?.usage !== undefined && chunk.usage !== null) yield { usage: chunk.usage }
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
        const delta = choice?.delta ?? {}
        const content = typeof delta.content === 'string' ? delta.content : ''
        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
        const calls = toolFragments(delta, indexer)
        if (content !== '' || reasoning !== '' || calls.length > 0) {
          yield { content, reasoning, toolCalls: calls }
        }
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
          yield { finishReason: choice.finish_reason }
        }
      }
      if (!sawFinish) { /* 上游直接关流也算正常结束 */ }
      return
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) throw error
      lastError = error
      if (attempt >= MAX_ATTEMPTS) throw error
    } finally {
      stream.close()
    }
  }
  throw lastError ?? new HttpError('Qoder 上游未返回内容')
}

/**
 * TRAE 聊天上游：POST /api/agent/v3/llm_utils_chat。
 *
 * 上游 SSE 事件是 `output` / `token_usage` / `done` / `error`，
 * 这里只把它们翻译成增量对象（content / reasoning / toolCalls / usage / finishReason），
 * 再交给 emit.js 转成宿主块协议。
 *
 * 协议来源：玖念/traework2api 的 TraeUpstream.kt（国服实测）。
 *
 * @module src/trae/upstream.js
 */

import { HttpError, readSse, streamFetch } from '../http.js'
import { DEFAULT_MODEL, regionOf } from './auth.js'
import { soloHeaders } from './models.js'

const EP_CHAT = '/api/agent/v3/llm_utils_chat'
const FUNCTION = 'solo_work_remote'
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

function sanitizeModel(value) {
  const model = typeof value === 'string' ? value.trim() : ''
  return MODEL_ID_RE.test(model) ? model : DEFAULT_MODEL
}

function normalizeToolChoice(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'tool_choice')) return
  const choice = body.tool_choice
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete body.tool_choice
      delete body.tools
      delete body.functions
    }
    return
  }
  if (choice !== null && typeof choice === 'object') {
    const type = String(choice.type ?? '').toLowerCase().trim()
    if (type === 'none') {
      delete body.tool_choice
      delete body.tools
      delete body.functions
    } else if (type === 'auto' || type === 'required') {
      body.tool_choice = type
    } else if (type === 'function') {
      const name = String(choice.function?.name ?? choice.name ?? '').trim()
      body.tool_choice = name !== '' ? name : 'auto'
    } else {
      delete body.tool_choice
    }
    return
  }
  delete body.tool_choice
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools)) return
  if (body.tools.length === 0) {
    delete body.tools
    return
  }
  const out = []
  for (const tool of body.tools) {
    if (tool === null || typeof tool !== 'object' || tool.function === null || typeof tool.function !== 'object') continue
    const parameters = tool.function.parameters
    if (parameters !== null && typeof parameters === 'object') {
      tool.function.parameters = JSON.stringify(parameters)
    }
    out.push(tool)
  }
  if (out.length === 0) delete body.tools
  else body.tools = out
}

/** OpenAI 请求体 → TRAE 请求体。 */
export function prepareBody(raw) {
  const body = structuredClone(raw ?? {})
  body.stream = true
  body.function = FUNCTION
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message === null || typeof message !== 'object') continue
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const kept = []
        for (const call of message.tool_calls) {
          if (call === null || typeof call !== 'object') continue
          if (call.function !== undefined && call.function_call === undefined) {
            call.function_call = call.function
            delete call.function
          }
          const fn = call.function_call
          if (fn === null || typeof fn !== 'object' || String(fn.name ?? '').trim() === '') continue
          kept.push(call)
        }
        if (kept.length === 0) delete message.tool_calls
        else message.tool_calls = kept
      }
      if (typeof message.content === 'string') {
        message.content = [{ type: 'text', text: message.content }]
      }
    }
  }
  const model = sanitizeModel(body.model)
  body.config_name = model
  body.model = model
  normalizeToolChoice(body)
  normalizeTools(body)
  return body
}

function toolFragments(raw) {
  const list = Array.isArray(raw) ? raw : (raw !== null && typeof raw === 'object' ? [raw] : [])
  const out = []
  list.forEach((call, order) => {
    if (call === null || typeof call !== 'object') return
    const fn = call.function ?? call.function_call ?? {}
    out.push({
      index: Number.isInteger(call.index) ? call.index : order,
      id: typeof call.id === 'string' ? call.id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string'
        ? fn.arguments
        : (typeof fn.partial_arguments === 'string' ? fn.partial_arguments : ''),
    })
  })
  return out
}

/**
 * 发一次聊天并逐帧产出增量。
 * @param {object} options
 * @param {object} options.body - prepareBody 的返回值
 * @param {object} options.account - 账号（accessToken / region / uid）
 * @param {AbortSignal} [options.signal]
 */
export async function * chatDeltas({ body, account, signal }) {
  const region = regionOf(account.region)
  if (typeof account.accessToken !== 'string' || account.accessToken === '') {
    throw new HttpError('TRAE 账号没有 accessToken，请重新登录')
  }
  const stream = await streamFetch(`${region.agentHost}${EP_CHAT}`, {
    method: 'POST',
    headers: soloHeaders(region, account.accessToken, account.uid, { stream: true }),
    body: JSON.stringify(body),
    signal,
  })
  try {
    if (!stream.response.ok) {
      const text = await stream.response.text().catch(() => '')
      throw new HttpError(`TRAE 上游 HTTP ${stream.response.status}`, {
        status: stream.response.status,
        body: text.slice(0, 300),
      })
    }
    for await (const frame of readSse(stream.response)) {
      stream.touch()
      if (frame.data === '' || frame.data === '[DONE]') continue
      let payload
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }
      switch (frame.event) {
        case 'output': {
          const reasoning = typeof payload.reasoning_content === 'string' ? payload.reasoning_content : ''
          const content = typeof payload.response === 'string' ? payload.response : ''
          const toolCalls = payload.tool_calls === null || payload.tool_calls === undefined
            ? []
            : toolFragments(payload.tool_calls)
          if (reasoning !== '' || content !== '' || toolCalls.length > 0) {
            yield { reasoning, content, toolCalls }
          }
          break
        }
        case 'token_usage':
          yield { usage: payload }
          break
        case 'done':
          yield { finishReason: typeof payload.finish_reason === 'string' ? payload.finish_reason : 'stop' }
          break
        case 'error':
          throw new Error(`TRAE 上游错误 code=${payload.code ?? ''} message=${payload.message ?? ''}`)
        default:
          break
      }
    }
  } finally {
    stream.close()
  }
}

/**
 * 极小的 HTTP / SSE 工具：只依赖 Node 内置 fetch。
 *
 * @module src/http.js
 */

export class HttpError extends Error {
  constructor(message, { status = 0, body = '', queue = false, retryAfterSeconds = 0 } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    /** 上游排队/资源受限（可换号或稍后重试），不算真正的配置错误。 */
    this.queue = queue
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * 递归解析上游的排队/限流响应，兼容 `message` 是 JSON 字符串、`error` 嵌套等情况。
 * 不是排队错误返回 null。
 */
export function queueInfoOf(value) {
  const stack = [value]
  for (let i = 0; i < 8 && stack.length > 0; i++) {
    const node = stack.pop()
    if (node === null || node === undefined) continue
    if (typeof node === 'string') {
      if (!/10605|RESOURCE_LIMIT|isQueued/.test(node)) continue
      try {
        stack.push(JSON.parse(node))
      } catch { /* 纯文本，忽略 */ }
      continue
    }
    if (typeof node !== 'object') continue
    const code = String(node.code ?? node.errorCode ?? '')
    const queued = node.isQueued === true
      || String(node.subCode ?? '') === 'RESOURCE_LIMIT'
      || String(node.sub_code ?? '') === 'RESOURCE_LIMIT'
      || code === '10605'
    if (queued) {
      let retry = Number(node.retryAfterSeconds ?? node.retry_after_seconds ?? 0)
      let modelKey = typeof node.modelKey === 'string' ? node.modelKey : ''
      // 外层只有 code，真正的 retryAfter/modelKey 常塞在 message 字符串里。
      if ((!Number.isFinite(retry) || retry <= 0 || modelKey === '') && typeof node.message === 'string') {
        try {
          const inner = JSON.parse(node.message)
          if (inner !== null && typeof inner === 'object') {
            const innerRetry = Number(inner.retryAfterSeconds ?? inner.retry_after_seconds ?? 0)
            if ((!Number.isFinite(retry) || retry <= 0) && Number.isFinite(innerRetry) && innerRetry > 0) retry = innerRetry
            if (modelKey === '' && typeof inner.modelKey === 'string') modelKey = inner.modelKey
          }
        } catch { /* 纯文本，忽略 */ }
      }
      return {
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : 0,
        modelKey,
      }
    }
    for (const child of Object.values(node)) {
      if (typeof child === 'string' || (child !== null && typeof child === 'object')) stack.push(child)
    }
  }
  return null
}

/** 统一的排队错误文案：给出原因和大约多久后重试，而不是把整段 JSON 抛给用户。 */
export function queueMessage(label, info) {
  const model = info.modelKey !== '' ? `「${info.modelKey}」` : ''
  const wait = info.retryAfterSeconds > 0 ? `，上游建议约 ${info.retryAfterSeconds} 秒后重试` : '，请稍后重试'
  return `${label} 模型${model}当前排队 / 资源受限（RESOURCE_LIMIT）${wait}。这是临时限流，不是配置问题；也可换一个模型或账号`
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 发一个请求并读完响应体；网络错误统一抛 HttpError。 */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  let onAbort
  if (signal !== undefined) {
    if (signal.aborted === true) controller.abort(signal.reason)
    else {
      onAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal })
    const text = await response.text()
    return { ok: response.ok, status: response.status, headers: response.headers, text, json: parseJson(text) }
  } catch (error) {
    if (error instanceof HttpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new HttpError(message, { body: '' })
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** 需要 2xx，否则抛出带状态码与响应体前缀的错误。 */
export async function requestOk(url, options = {}) {
  const response = await request(url, options)
  if (!response.ok) {
    throw new HttpError(`${options.label ?? '请求'} HTTP ${response.status}`, {
      status: response.status,
      body: response.text.slice(0, 400),
    })
  }
  return response
}

/**
 * 把响应体按 SSE 帧拆开。
 *
 * 只处理 `event:` / `data:` / 空行；`data:` 多行用 `\n` 连接（与浏览器 EventSource 一致）。
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function * readSse(response) {
  const body = response.body
  if (body === null || body === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data = []
  const flush = () => {
    if (event === '' && data.length === 0) return undefined
    const frame = { event, data: data.join('\n') }
    event = ''
    data = []
    return frame
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    while (true) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      let line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') {
        const frame = flush()
        if (frame !== undefined) yield frame
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        let value = line.slice(5)
        if (value.startsWith(' ')) value = value.slice(1)
        data.push(value)
      }
    }
  }
  buffer += decoder.decode()
  if (buffer !== '') {
    const line = buffer.replace(/\r$/, '')
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    else if (line.startsWith('event:')) event = line.slice(6).trim()
  }
  const frame = flush()
  if (frame !== undefined) yield frame
}

/**
 * 打开一个流式响应。
 *
 * 与 `request()` 的区别：不读 body，交给调用方按 SSE 消费；用一个「静默超时」
 * 看门狗兜底（每次收到数据调用 touch() 重置），而不是固定总时长 —— 长回答不会被
 * 误杀，真正卡死又能自己结束。
 *
 * @returns {{response: Response, touch: () => void, close: () => void}}
 */
export async function streamFetch(url, { method = 'POST', headers = {}, body, idleMs = 300_000, signal } = {}) {
  const controller = new AbortController()
  let timer = null
  const arm = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error('idle timeout')), idleMs)
    timer.unref?.()
  }
  arm()
  let onAbort
  if (signal !== undefined) {
    if (signal.aborted === true) controller.abort(signal.reason)
    else {
      onAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }
  const close = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal })
    return { response, touch: arm, close }
  } catch (error) {
    close()
    const message = error instanceof Error ? error.message : String(error)
    throw new HttpError(message)
  }
}

export { parseJson }

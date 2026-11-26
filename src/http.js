/**
 * 极小的 HTTP / SSE 工具：只依赖 Node 内置 fetch。
 *
 * @module src/http.js
 */

export class HttpError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
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

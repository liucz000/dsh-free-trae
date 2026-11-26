/**
 * Harness 消息 → OpenAI messages。
 *
 * 宿主给的是块结构（text / image / tool-result / tool-call），这里只做投影：
 * 文本原样、图片转 image_url（没有可取 URL 时降级成一句占位）、工具结果拆成
 * role=tool 的消息。未知块直接丢掉，绝不把内部结构透给上游。
 *
 * @module src/messages.js
 */

function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content
    .map(part => {
      if (typeof part === 'string') return { type: 'text', text: part }
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
        return { type: 'text', text: String(part.text ?? '') }
      }
      return part !== null && typeof part === 'object' ? part : null
    })
    .filter(block => block !== null)
}

function textOf(blocks) {
  return (blocks ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function callIdOf(message) {
  const raw = message?.toolCallId ?? message?.tool_call_id ?? message?.source?.callId
  return typeof raw === 'string' && raw !== '' ? raw : null
}

function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = callIdOf(message)
    return id === null ? [] : [{ callId: id, content: blocksOf(message.content) }]
  }
  const out = []
  for (const block of blocksOf(message?.content)) {
    if (block.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? block.tool_call_id ?? message?.source?.callId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content) })
  }
  return out
}

function imageParts(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: String(block.text ?? '') })
      continue
    }
    if (block.type !== 'image') continue
    const url = typeof block.attachment?.url === 'string' ? block.attachment.url : ''
    if (url !== '') parts.push({ type: 'image_url', image_url: { url } })
    else parts.push({ type: 'text', text: '[image omitted]' })
  }
  return parts
}

function normalizeToolCalls(raw, blocks) {
  const calls = []
  if (Array.isArray(raw)) {
    for (const call of raw) {
      if (call === null || typeof call !== 'object') continue
      const fn = call.function ?? call.function_call ?? call
      const name = String(fn?.name ?? '')
      if (name === '') continue
      const args = typeof fn?.arguments === 'string'
        ? fn.arguments
        : JSON.stringify(fn?.arguments ?? {})
      calls.push({
        id: String(call.id ?? ''),
        type: 'function',
        function: { name, arguments: args },
      })
    }
  }
  if (calls.length > 0) return calls
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    const name = String(block.name ?? '')
    if (name === '') continue
    calls.push({
      id: String(block.id ?? ''),
      type: 'function',
      function: {
        name,
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      },
    })
  }
  return calls
}

/**
 * @param {Array<object>} messages - harness GenerateOptions.messages
 * @returns {Array<object>} OpenAI chat.completion messages
 */
export function toOpenAiMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const results = toolResultsOf(message)
    for (const result of results) {
      const text = textOf(result.content)
      out.push({
        role: 'tool',
        tool_call_id: result.callId,
        content: text === '' ? '(no output)' : text,
      })
    }
    if (results.length > 0) continue

    const blocks = blocksOf(message.content)
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text !== '') out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const hasImage = blocks.some(block => block.type === 'image')
        if (!hasImage) {
          const text = textOf(blocks)
          if (text !== '') out.push({ role: 'user', content: text })
          break
        }
        out.push({ role: 'user', content: imageParts(blocks) })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = normalizeToolCalls(message.tool_calls ?? message.toolCalls, blocks)
        if (calls.length > 0) out.push({ role: 'assistant', content: text, tool_calls: calls })
        else if (text !== '') out.push({ role: 'assistant', content: text })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * 工具定义：宿主给的是 {name, description, parameters} 或 {function:{...}}。
 *
 * TRAE 要求 `parameters` 是 JSON 字符串。由调用方决定是否 stringify，
 * 不要在这里统一 —— 上游对字段类型的容忍度不一样。
 */
export function toToolDefs(tools, { stringify = false } = {}) {
  const out = []
  for (const tool of tools ?? []) {
    if (tool === null || typeof tool !== 'object') continue
    const fn = tool.function ?? tool
    const name = String(fn.name ?? tool.name ?? '')
    if (name === '') continue
    const parameters = fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} }
    out.push({
      type: 'function',
      function: {
        name,
        description: String(fn.description ?? tool.description ?? ''),
        parameters: stringify && typeof parameters !== 'string' ? JSON.stringify(parameters) : parameters,
      },
    })
  }
  return out
}

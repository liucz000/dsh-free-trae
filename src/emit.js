/**
 * 上游增量 → 宿主块协议。
 *
 * 宿主认这几种事件（与 dsh-get-it-for-free 的 stream.js 一致）：
 *   block-start / text-delta / reasoning-delta / tool-call-delta / block-end
 *   usage / finish
 *
 * 本模块只做状态管理，不发网络请求，便于自检。
 *
 * @module src/emit.js
 */

function number(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** 上游 usage（可能是 prompt_tokens 或 input_tokens 口径）→ 宿主 usage。 */
export function mapUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const input = number(raw.inputTokens ?? raw.input_tokens ?? raw.prompt_tokens)
  const output = number(raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens)
  const total = number(raw.totalTokens ?? raw.total_tokens) ?? (input !== undefined || output !== undefined
    ? (input ?? 0) + (output ?? 0)
    : undefined)
  if (input === undefined && output === undefined && total === undefined) return undefined
  const usage = {}
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (total !== undefined) usage.totalTokens = total
  const cached = number(raw.cachedTokens ?? raw.cached_tokens)
  if (cached !== undefined) usage.cachedTokens = cached
  return usage
}

/** 上游 finish_reason → 宿主的 reason.kind。 */
export function mapFinish(reason, sawToolCall) {
  if (sawToolCall === true && (reason === undefined || reason === '' || reason === 'stop')) {
    return { kind: 'tool-calls' }
  }
  switch (reason) {
    case 'tool_calls':
    case 'tool-call':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return { kind: 'error', failure: { message: '上游内容过滤中止了回答', code: 'CONTENT_FILTER' } }
    default:
      return { kind: 'stop' }
  }
}

/**
 * 有状态的块发射器。
 *
 * 用法：不断调用 text()/reasoning()/toolCall()，每次调用后 drain() 取出新增事件；
 * 结束时 close() 收尾，再汇总 usage/finish。
 */
export class HarnessEmitter {
  constructor() {
    this.pending = []
    this.nextIndex = 0
    this.textBlock = null
    this.reasoningBlock = null
    this.toolBlocks = new Map()
    this.usage = undefined
    this.finishReason = ''
    this.sawToolCall = false
  }

  drain() {
    const events = this.pending
    this.pending = []
    return events
  }

  startText() {
    if (this.textBlock !== null) return this.textBlock
    const index = this.nextIndex++
    this.textBlock = { index, text: '' }
    this.pending.push({ type: 'block-start', index, blockType: 'text' })
    return this.textBlock
  }

  startReasoning() {
    if (this.reasoningBlock !== null) return this.reasoningBlock
    const index = this.nextIndex++
    this.reasoningBlock = { index, text: '' }
    this.pending.push({ type: 'block-start', index, blockType: 'reasoning' })
    return this.reasoningBlock
  }

  text(delta) {
    if (typeof delta !== 'string' || delta === '') return
    const block = this.startText()
    block.text += delta
    this.pending.push({ type: 'text-delta', index: block.index, text: delta })
  }

  reasoning(delta) {
    if (typeof delta !== 'string' || delta === '') return
    const block = this.startReasoning()
    block.text += delta
    this.pending.push({ type: 'reasoning-delta', index: block.index, text: delta })
  }

  /**
   * @param {{index?: number, id?: string, name?: string, arguments?: string}} call
   */
  toolCall(call) {
    const key = Number.isInteger(call.index) ? call.index : (this.toolBlocks.size === 0 ? 0 : this.toolBlocks.size)
    let block = this.toolBlocks.get(key)
    if (block === undefined) {
      const index = this.nextIndex++
      block = { index, id: String(call.id ?? ''), name: '', arguments: '' }
      this.toolBlocks.set(key, block)
      this.sawToolCall = true
      this.pending.push({ type: 'block-start', index, blockType: 'tool-call' })
    }
    if (typeof call.id === 'string' && call.id !== '') {
      if (block.id === '') block.id = call.id
    }
    const name = typeof call.name === 'string' ? call.name : ''
    const args = typeof call.arguments === 'string' ? call.arguments : ''
    if (name !== '' && block.name === '') block.name = name
    if (args !== '') block.arguments += args
    if (block.id === '') block.id = `call_${key}_${block.index}`
    this.pending.push({
      type: 'tool-call-delta',
      index: block.index,
      id: block.id,
      ...(name !== '' ? { name } : {}),
      argumentsDelta: args,
    })
  }

  setUsage(raw) {
    const usage = mapUsage(raw)
    if (usage !== undefined) this.usage = usage
  }

  setFinish(reason) {
    if (typeof reason === 'string' && reason !== '') this.finishReason = reason
  }

  /** 关闭所有打开的块，返回收尾事件。 */
  close() {
    if (this.reasoningBlock !== null && this.reasoningBlock.text !== '') {
      this.pending.push({
        type: 'block-end',
        index: this.reasoningBlock.index,
        block: { type: 'reasoning', text: this.reasoningBlock.text },
      })
    }
    if (this.textBlock !== null && this.textBlock.text !== '') {
      this.pending.push({
        type: 'block-end',
        index: this.textBlock.index,
        block: { type: 'text', text: this.textBlock.text },
      })
    }
    for (const block of this.toolBlocks.values()) {
      this.pending.push({
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: block.id,
          name: block.name,
          arguments: block.arguments === '' ? '{}' : block.arguments,
        },
      })
    }
    this.reasoningBlock = null
    this.textBlock = null
    this.toolBlocks = new Map()
    return this.drain()
  }
}

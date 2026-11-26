/**
 * 宿主 LLM 适配器：只注册 trae / qoder 两个 provider。
 *
 * 负责把宿主的一次生成请求落到某个账号上：
 *  1. 选账号（选中优先，失败再试一个）→ 临期续期；
 *  2. 组装请求体 → 调上游 SSE → 翻译成宿主块事件；
 *  3. 401 时强制续期重试一次；还没吐字前失败则换下一个账号。
 *
 * @module src/adapter.js
 */

import { HttpError } from './http.js'
import { toOpenAiMessages, toToolDefs } from './messages.js'
import { HarnessEmitter, mapFinish } from './emit.js'
import {
  ensureFresh as traeEnsureFresh,
  refreshAccount as traeRefreshAccount,
} from './trae/auth.js'
import { fetchModels as traeFetchModels, FALLBACK_MODELS } from './trae/models.js'
import { chatDeltas as traeChatDeltas, prepareBody as traePrepareBody } from './trae/upstream.js'
import {
  ensureFresh as qoderEnsureFresh,
  refreshAccount as qoderRefreshAccount,
} from './qoder/auth.js'
import { BUILTIN, fetchCatalog, resolveModel as qoderResolveModel } from './qoder/models.js'
import { chatDeltas as qoderChatDeltas, prepareBody as qoderPrepareBody } from './qoder/upstream.js'

const LABELS = { trae: 'TRAE', qoder: 'Qoder' }
const IMAGE_PRICING = Object.freeze({
  priceImages(images) {
    return images.map(image => (image?.offloaded === true
      ? { visualTokens: 0, text: '[image omitted]' }
      : { visualTokens: 1024, text: '[image]' }))
  },
})

function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim().replace(/^(trae|qoder)[:/]/, '')
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 倍率 → 紧凑文本（整数不带小数，其余最多两位）。 */
export function formatFactor(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)))
}

/**
 * Qoder 计费倍率 → 模型选择器里的小标签。
 * 免费（0）用 success，有倍率用 info，未知（null）不显示。
 */
export function priceBadge(priceFactor) {
  if (priceFactor === null || priceFactor === undefined) return undefined
  const number = Number(priceFactor)
  if (!Number.isFinite(number) || number < 0) return undefined
  if (number === 0) return { text: '免费', tone: 'success' }
  return { text: `×${formatFactor(number)}`, tone: 'info' }
}

function isRetryable(error) {
  if (error instanceof HttpError) return error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500
  return /fetch failed|ECONN|ETIMEDOUT|socket|aborted/i.test(errorMessage(error))
}

export function createAdapter({ store, logger = console } = {}) {
  function orderedAccounts(provider) {
    const rows = store.list(provider)
    if (rows.length === 0) return []
    const activeId = store.current(provider)?.id
    const active = rows.filter(row => row.id === activeId)
    return [...active, ...rows.filter(row => row.id !== activeId)]
  }

  async function ensure(provider, account) {
    const options = { store }
    if (provider === 'trae') return traeEnsureFresh(account, options)
    return qoderEnsureFresh(account, options)
  }

  async function forceRefresh(provider, account) {
    if (provider === 'trae') return traeRefreshAccount(account, { store })
    return qoderRefreshAccount(account, { store })
  }

  function buildMessages(options) {
    return toOpenAiMessages(options.messages)
  }

  function buildBaseBody(options, messages, provider) {
    const body = { model: baseModelId(options.model), messages, stream: true }
    const tools = toToolDefs(options.tools, { stringify: provider === 'trae' })
    if (tools.length > 0) {
      body.tools = tools
      if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice
    }
    if (Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0) body.max_tokens = Number(options.maxTokens)
    if (Number.isFinite(Number(options.temperature)) && options.temperature !== null && options.temperature !== undefined) {
      body.temperature = Number(options.temperature)
    }
    if (Number.isFinite(Number(options.topP)) && options.topP !== null && options.topP !== undefined) body.top_p = Number(options.topP)
    if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') {
      body.reasoning_effort = options.reasoningEffort
    }
    return body
  }

  async function traeModelsFor(account) {
    try {
      return await traeFetchModels(account)
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        try {
          const fresh = await traeRefreshAccount(account, { store })
          return await traeFetchModels(fresh)
        } catch {
          throw error
        }
      }
      throw error
    }
  }

  function fallbackTraeModels(provider, description) {
    return FALLBACK_MODELS.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description,
      inputModalities: ['text'],
    }))
  }

  async function listTraeModels(provider) {
    const account = store.current('trae')
    if (account === null || account === undefined) {
      // 返回空数组会让宿主的模型目录直接丢掉整个 provider 分组（选择器里什么都看不到）。
      // 先列出兜底模型并注明未登录，用户选中后调用会得到明确的「请先登录」提示。
      return fallbackTraeModels(provider, 'TRAE 未登录（请到设置页登录后使用）')
    }
    try {
      const models = await traeModelsFor(account)
      return models.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        description: 'TRAE 内置模型',
        inputModalities: ['text'],
      }))
    } catch (error) {
      logger.warn?.(`[trae-qoder] TRAE 模型目录拉取失败：${errorMessage(error)}`)
      // 目录接口对国际服不一定可用；至少把兜底模型列出来，别让选择器空着。
      return fallbackTraeModels(provider, 'TRAE 兜底模型（目录未同步）')
    }
  }

  async function listQoderModels(provider) {
    const account = store.current('qoder')
    const models = account === null || account === undefined
      ? BUILTIN.map(entry => ({ ...entry, maxOutput: Math.min(32_000, entry.contextWindow) }))
      : await fetchCatalog(account)
    return models.map(model => {
      const badge = priceBadge(model.priceFactor)
      const description = model.priceFactor === 0
        ? 'Qoder 免费模型'
        : (model.priceFactor === null || model.priceFactor === undefined
          ? 'Qoder 内置模型'
          : `Qoder 计费倍率 ×${formatFactor(model.priceFactor)}`)
      return {
        provider,
        id: model.id,
        name: model.name,
        description,
        inputModalities: ['text'],
        ...(badge === undefined ? {} : { badge }),
      }
    })
  }

  async function resolveTrae(provider, model) {
    const id = baseModelId(model)
    const account = store.current('trae')
    let entry
    if (account !== null && account !== undefined) {
      try {
        entry = (await traeModelsFor(account)).find(item => item.id === id)
      } catch { /* 用兜底容量 */ }
    }
    return {
      provider,
      id,
      name: entry?.name ?? id,
      inputModalities: ['text'],
      context: { contextWindow: entry?.contextWindow ?? 131_072 },
      defaultMaxTokens: Math.min(entry?.maxOutput ?? 32_768, 32_768),
    }
  }

  async function resolveQoder(provider, model) {
    const entry = qoderResolveModel(baseModelId(model))
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: Math.min(entry.maxOutput ?? 32_000, 32_000),
    }
  }

  function resolveModel(provider, model) {
    return provider === 'trae' ? resolveTrae(provider, model) : resolveQoder(provider, model)
  }

  async function * stream(options, provider = options?.provider, model = options?.model) {
    // 宿主有两条调用路径：prepareCall 闭包会显式传 provider/model，
    // 而 LlmRuntime 也可能直接 adapter.stream(options)——此时只能从 options 里取。
    if (provider !== 'trae' && provider !== 'qoder') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `未知 provider「${String(provider)}」`, code: 'UNKNOWN_PROVIDER' },
        },
      }
      return
    }
    void model
    const controller = new AbortController()
    const outer = options.signal
    const onAbort = () => controller.abort(outer?.reason)
    if (outer?.aborted === true) onAbort()
    else outer?.addEventListener('abort', onAbort, { once: true })
    const signal = controller.signal

    try {
      const accounts = orderedAccounts(provider)
      if (accounts.length === 0) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: `${LABELS[provider]} 还没有登录账号，请到设置页添加`, code: 'NO_ACCOUNT' },
          },
        }
        return
      }
      const messages = buildMessages(options)
      if (messages.length === 0) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: '没有可发送的消息', code: 'EMPTY_REQUEST' } },
        }
        return
      }
      const base = buildBaseBody(options, messages, provider)
      let emitted = false
      let lastError = null

      candidates: for (const candidate of accounts.slice(0, 2)) {
        let account = candidate
        try {
          account = await ensure(provider, account)
        } catch (error) {
          lastError = error
          logger.warn?.(`[trae-qoder] ${LABELS[provider]} 续期失败：${errorMessage(error)}`)
          if (accounts.indexOf(candidate) < accounts.slice(0, 2).length - 1) continue
        }
        for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
          const emitter = new HarnessEmitter()
          const attemptAccount = account
          const body = provider === 'trae'
            ? traePrepareBody(base)
            : qoderPrepareBody(base, attemptAccount)
          try {
            const deltas = provider === 'trae'
              ? traeChatDeltas({ body, account: attemptAccount, signal })
              : qoderChatDeltas({ body, account: attemptAccount, signal })
            for await (const delta of deltas) {
              if (delta.usage !== undefined) emitter.setUsage(delta.usage)
              if (delta.finishReason !== undefined) emitter.setFinish(delta.finishReason)
              if (typeof delta.reasoning === 'string' && delta.reasoning !== '') emitter.reasoning(delta.reasoning)
              if (typeof delta.content === 'string' && delta.content !== '') emitter.text(delta.content)
              for (const call of delta.toolCalls ?? []) emitter.toolCall(call)
              const events = emitter.drain()
              if (events.length > 0) {
                emitted = true
                yield * events
              }
            }
            const tail = emitter.close()
            if (tail.length > 0) {
              emitted = true
              yield * tail
            }
            if (emitter.usage !== undefined) yield { type: 'usage', usage: emitter.usage }
            yield { type: 'finish', reason: mapFinish(emitter.finishReason, emitter.sawToolCall) }
            return
          } catch (error) {
            lastError = error
            const status = error instanceof HttpError ? error.status : 0
            // 401：续期后同一账号再试一次（只试一次，避免死循环）。
            if (status === 401 && authAttempt === 0) {
              try {
                account = await forceRefresh(provider, attemptAccount)
                logger.info?.(`[trae-qoder] ${LABELS[provider]} 已续期，重试一次`)
                continue
              } catch (refreshError) {
                lastError = refreshError
              }
            }
            logger.warn?.(`[trae-qoder] ${LABELS[provider]} 请求失败：${errorMessage(error)}`)
            // 还没吐字 + 还有别的账号 + 错误看起来是账号级/瞬时问题 → 换号
            if (!emitted && isRetryable(error) && accounts.slice(0, 2).indexOf(candidate) < accounts.slice(0, 2).length - 1) {
              continue candidates
            }
            if (signal.aborted === true) {
              yield { type: 'finish', reason: { kind: 'aborted' } }
              return
            }
            const tail = emitter.close()
            if (tail.length > 0 && emitted) yield * tail
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: { message: errorMessage(lastError), code: status === 401 ? 'UNAUTHORIZED' : 'UPSTREAM' },
              },
            }
            return
          }
        }
      }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: errorMessage(lastError ?? '没有可用账号'), code: 'NO_ACCOUNT' } },
      }
    } finally {
      outer?.removeEventListener('abort', onAbort)
    }
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: LABELS[provider] ?? provider }
    },

    /** 不在宿主层重试：换号逻辑自己做了，重复重试只会多花额度。 */
    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: Object.freeze([]),
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      })
    },

    imageRequestPricing() {
      return IMAGE_PRICING
    },

    imageRequestTarget(_provider, _model, image) {
      return { width: image?.width ?? 0, height: image?.height ?? 0 }
    },

    async listModels(provider) {
      return provider === 'trae' ? listTraeModels(provider) : listQoderModels(provider)
    },

    resolveModel,

    async prepareCall(provider, model) {
      return {
        model: await resolveModel(provider, model),
        stream: options => stream(options, provider, model),
      }
    },

    stream(options, provider, model) {
      return stream(options, provider, model)
    },
  }
}

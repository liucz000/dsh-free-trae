/**
 * dsh-trae-qoder — Host 半身。
 *
 * 只做两条渠道：
 *   - trae  : TRAE 国服 / 国际服（浏览器授权 + 手动粘贴回调）
 *   - qoder : Qoder 国内 / 国际（PAT 或浏览器设备授权）
 *
 * 不包含其它任何渠道、任何中转/免登录池。账号与 token 只落在
 * `~/.dsh/trae-qoder/accounts.json`（0600），HTTP 接口只返回掩码视图。
 *
 * @module dsh-trae-qoder
 */

import crypto from 'node:crypto'

import { createAdapter } from './src/adapter.js'
import { createStore, resolveDshHome } from './src/store.js'
import {
  REGIONS as TRAE_REGIONS,
  buildLoginUrl as buildTraeLoginUrl,
  loginWithCallback as traeLoginWithCallback,
  refreshAccount as traeRefreshAccount,
} from './src/trae/auth.js'
import { clearModelCache } from './src/trae/models.js'
import {
  REGIONS as QODER_REGIONS,
  buildAuthUrl as buildQoderAuthUrl,
  createDeviceSession,
  loginWithPat as qoderLoginWithPat,
  pollDeviceSession,
  refreshAccount as qoderRefreshAccount,
} from './src/qoder/auth.js'
import { clearCatalogCache } from './src/qoder/models.js'
import { publicAccount } from './src/store.js'
export const name = 'trae-qoder'
export const inject = ['llm']

const API_PREFIX = '/api/trae-qoder'
const DEVICE_TTL_MS = 10 * 60_000
const MAX_BODY_BYTES = 1 << 20

function textOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function regionList(regions) {
  return Object.values(regions).map(region => ({ id: region.id, label: region.label }))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function createHandler({ store, logger, adapter }) {
  const deviceSessions = new Map()

  function sweepSessions() {
    const now = Date.now()
    for (const [id, session] of deviceSessions) {
      if (now - session.createdAt > DEVICE_TTL_MS) deviceSessions.delete(id)
    }
  }

  function summary() {
    return {
      ok: true,
      providers: {
        trae: { label: 'TRAE', regions: regionList(TRAE_REGIONS) },
        qoder: { label: 'Qoder', regions: regionList(QODER_REGIONS) },
      },
      accounts: store.snapshot(),
      dataDir: store.dir,
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const routePath = url.pathname.replace(new RegExp(`^${API_PREFIX}`), '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    const cors = origin === ''
      ? {}
      : {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
          vary: 'origin',
        }
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...cors,
      })
      res.end(body)
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    try {
      if (method === 'GET' && routePath === '/summary') return send(200, summary())

      if (method === 'POST' && routePath === '/trae/login/url') {
        const body = await readJson(req)
        const region = typeof body.region === 'string' ? body.region : 'cn'
        if (!(region in TRAE_REGIONS)) return send(400, { error: `未知区域 ${region}` })
        return send(200, { ok: true, region, url: buildTraeLoginUrl(region) })
      }

      if (method === 'POST' && routePath === '/trae/login') {
        const body = await readJson(req)
        const region = typeof body.region === 'string' ? body.region : 'cn'
        if (!(region in TRAE_REGIONS)) return send(400, { error: `未知区域 ${region}` })
        const callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : ''
        if (callbackUrl.trim() === '') return send(400, { error: '请粘贴登录后跳转的完整地址' })
        const account = await traeLoginWithCallback(callbackUrl, region)
        store.add('trae', account)
        clearModelCache()
        return send(200, { ok: true, account: publicAccount('trae', account), summary: summary() })
      }

      if (method === 'POST' && routePath === '/qoder/login/pat') {
        const body = await readJson(req)
        const region = typeof body.region === 'string' ? body.region : 'cn'
        if (!(region in QODER_REGIONS)) return send(400, { error: `未知区域 ${region}` })
        const pat = typeof body.pat === 'string' ? body.pat : ''
        const account = await qoderLoginWithPat(pat, region)
        store.add('qoder', account)
        clearCatalogCache()
        return send(200, { ok: true, account: publicAccount('qoder', account), summary: summary() })
      }

      if (method === 'POST' && routePath === '/qoder/login/url') {
        const body = await readJson(req)
        const region = typeof body.region === 'string' ? body.region : 'cn'
        if (!(region in QODER_REGIONS)) return send(400, { error: `未知区域 ${region}` })
        sweepSessions()
        const session = createDeviceSession(region)
        const id = crypto.randomUUID()
        deviceSessions.set(id, session)
        return send(200, { ok: true, sessionId: id, region, url: buildQoderAuthUrl(session) })
      }

      if (method === 'GET' && routePath === '/qoder/login/poll') {
        sweepSessions()
        const id = url.searchParams.get('id') ?? ''
        const session = deviceSessions.get(id)
        if (session === undefined) return send(404, { error: '授权会话已过期，请重新发起' })
        const result = await pollDeviceSession(session)
        if (result.pending === true) return send(200, { ok: true, pending: true })
        store.add('qoder', result.account)
        deviceSessions.delete(id)
        clearCatalogCache()
        return send(200, { ok: true, pending: false, account: publicAccount('qoder', result.account), summary: summary() })
      }

      if (method === 'POST' && routePath === '/accounts/active') {
        const body = await readJson(req)
        const provider = body.provider === 'qoder' ? 'qoder' : (body.provider === 'trae' ? 'trae' : '')
        if (provider === '') return send(400, { error: 'provider 必须是 trae 或 qoder' })
        if (!store.select(provider, String(body.id ?? ''))) return send(404, { error: '账号不存在' })
        return send(200, summary())
      }

      if (method === 'POST' && routePath === '/accounts/remove') {
        const body = await readJson(req)
        const provider = body.provider === 'qoder' ? 'qoder' : (body.provider === 'trae' ? 'trae' : '')
        if (provider === '') return send(400, { error: 'provider 必须是 trae 或 qoder' })
        const removed = store.remove(provider, String(body.id ?? ''))
        return send(removed ? 200 : 404, removed ? summary() : { error: '账号不存在' })
      }

      if (method === 'POST' && routePath === '/accounts/refresh') {
        const body = await readJson(req)
        const provider = body.provider === 'qoder' ? 'qoder' : (body.provider === 'trae' ? 'trae' : '')
        if (provider === '') return send(400, { error: 'provider 必须是 trae 或 qoder' })
        const account = store.list(provider).find(row => row.id === String(body.id ?? ''))
        if (account === undefined) return send(404, { error: '账号不存在' })
        const updated = provider === 'trae'
          ? await traeRefreshAccount(account, { store })
          : await qoderRefreshAccount(account, { store })
        return send(200, { ok: true, account: publicAccount(provider, updated), summary: summary() })
      }

      if (method === 'GET' && routePath === '/models') {
        const provider = url.searchParams.get('provider') === 'qoder' ? 'qoder' : 'trae'
        const models = await adapter.listModels(provider)
        return send(200, {
          ok: true,
          provider,
          models: models.map(model => ({
            id: model.id,
            name: model.name,
            contextWindow: Number(model.context?.contextWindow ?? 0) || undefined,
          })),
        })
      }

      return send(404, { error: `未知接口 ${method} ${routePath}` })
    } catch (error) {
      logger.warn?.(`[trae-qoder] ${method} ${routePath} 失败：${textOf(error)}`)
      const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 400
      return send(status, { error: textOf(error) })
    }
  }
}

/**
 * @param {object} ctx - cordis 插件上下文
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const store = createStore({ home: config.home ?? resolveDshHome() })
  const adapter = createAdapter({ store, logger })

  const registration = ctx.llm.registerAdapter(['trae', 'qoder'], adapter)
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name
  ctx.llm.registerConfigurableProviders?.([
    { provider: 'trae', displayName: 'TRAE', settingsNs, settingsPath: [] },
    { provider: 'qoder', displayName: 'Qoder', settingsNs, settingsPath: [] },
  ])

  const handler = createHandler({ store, logger, adapter })
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'trae-qoder: settings API',
    )
    logger.info?.(`trae-qoder: 设置接口挂在 ${API_PREFIX}`)
  })

  ctx.effect(() => () => {
    try { registration?.() } catch { /* 宿主已在拆卸 */ }
  }, 'trae-qoder: adapter routes')
}

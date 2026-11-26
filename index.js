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
 * 设置页的接口有两条挂载路径，二选一都可用：
 *   1. `ctx.connection.fetch`：共享 `/api` 通道上的精确 Fetch 路由。Web 与桌面端
 *      （Electron 走 IPC 桥，不提供 webServer）都走这条。
 *   2. `ctx.webServer`：`/api/trae-qoder` 前缀路由，作为没有 connection 时的兜底。
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

/** 设置页用到的全部接口：路径后缀 → 允许的方法。 */
const ENDPOINTS = [
  { path: '/summary', methods: ['GET'] },
  { path: '/trae/login/url', methods: ['POST'] },
  { path: '/trae/login', methods: ['POST'] },
  { path: '/qoder/login/pat', methods: ['POST'] },
  { path: '/qoder/login/url', methods: ['POST'] },
  { path: '/qoder/login/poll', methods: ['GET'] },
  { path: '/accounts/active', methods: ['POST'] },
  { path: '/accounts/remove', methods: ['POST'] },
  { path: '/accounts/refresh', methods: ['POST'] },
  { path: '/models', methods: ['GET'] },
]

function textOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function regionList(regions) {
  return Object.values(regions).map(region => ({ id: region.id, label: region.label }))
}

function parseBody(text) {
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 与传输方式无关的路由：输入方法、路径、查询串和已解析的请求体，输出状态码与 JSON。
 * @param {{ store: object, logger: object, adapter: object }} deps
 */
export function createRouter({ store, logger, adapter }) {
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

  const send = (status, payload) => ({ status, payload })

  async function dispatch(method, pathname, query, body) {
    const routePath = pathname.replace(new RegExp(`^${API_PREFIX}`), '').replace(/\/+$/, '') || '/'
    try {
      if (method === 'GET' && routePath === '/summary') return send(200, summary())

      if (method === 'POST' && routePath === '/trae/login/url') {
        const region = typeof body.region === 'string' ? body.region : 'cn'
        if (!(region in TRAE_REGIONS)) return send(400, { error: `未知区域 ${region}` })
        return send(200, { ok: true, region, url: buildTraeLoginUrl(region) })
      }

      if (method === 'POST' && routePath === '/trae/login') {
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
        const region = typeof body.region === 'string' ? body.region : 'cn'
        if (!(region in QODER_REGIONS)) return send(400, { error: `未知区域 ${region}` })
        const pat = typeof body.pat === 'string' ? body.pat : ''
        const account = await qoderLoginWithPat(pat, region)
        store.add('qoder', account)
        clearCatalogCache()
        return send(200, { ok: true, account: publicAccount('qoder', account), summary: summary() })
      }

      if (method === 'POST' && routePath === '/qoder/login/url') {
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
        const id = query.get('id') ?? ''
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
        const provider = body.provider === 'qoder' ? 'qoder' : (body.provider === 'trae' ? 'trae' : '')
        if (provider === '') return send(400, { error: 'provider 必须是 trae 或 qoder' })
        if (!store.select(provider, String(body.id ?? ''))) return send(404, { error: '账号不存在' })
        return send(200, summary())
      }

      if (method === 'POST' && routePath === '/accounts/remove') {
        const provider = body.provider === 'qoder' ? 'qoder' : (body.provider === 'trae' ? 'trae' : '')
        if (provider === '') return send(400, { error: 'provider 必须是 trae 或 qoder' })
        const removed = store.remove(provider, String(body.id ?? ''))
        return send(removed ? 200 : 404, removed ? summary() : { error: '账号不存在' })
      }

      if (method === 'POST' && routePath === '/accounts/refresh') {
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
        const provider = query.get('provider') === 'qoder' ? 'qoder' : 'trae'
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

  return { dispatch, summary }
}

/** node:http（webServer 的前缀兜底路由）。 */
function httpHandler(router) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
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
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...cors,
      })
      res.end(JSON.stringify(payload))
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    let body = {}
    if (method === 'POST') {
      const chunks = []
      let size = 0
      try {
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
          chunks.push(chunk)
        }
        body = parseBody(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        send(400, { error: textOf(error) })
        return
      }
    }

    const result = await router.dispatch(method, url.pathname, url.searchParams, body)
    send(result.status, result.payload)
  }
}

/** 共享 `/api` 通道上的精确 Fetch 路由（Web 与桌面端通用）。 */
function fetchHandler(router, pathname) {
  return async function fetch(request) {
    const url = new URL(request.url)
    let body = {}
    if (request.method === 'POST') {
      const text = await request.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
        return new Response(JSON.stringify({ error: '请求体过大' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      try {
        body = parseBody(text)
      } catch (error) {
        return new Response(JSON.stringify({ error: textOf(error) }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
    }
    const result = await router.dispatch(request.method, pathname, url.searchParams, body)
    return new Response(JSON.stringify(result.payload), {
      status: result.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
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

  const router = createRouter({ store, logger, adapter })
  let mounted = false

  // 首选：共享 /api 通道的精确路由。桌面端没有 webServer，只有这条能生效。
  ctx.inject(['connection'], scoped => {
    const connection = scoped.connection
    if (connection?.fetch?.register === undefined) return
    for (const endpoint of ENDPOINTS) {
      const path = `${API_PREFIX}${endpoint.path}`
      const handler = fetchHandler(router, path)
      scoped.effect(
        () => connection.fetch.register({
          path,
          methods: endpoint.methods,
          requestBody: 'buffered',
          fetch: handler,
        }),
        `trae-qoder: ${path}`,
      )
    }
    mounted = true
    logger.info?.(`trae-qoder: 设置接口挂在共享通道 ${API_PREFIX}`)
  })

  // 兜底：没有 connection 的宿主（例如精简 Web 组合）用 webServer 前缀路由。
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler: httpHandler(router) }),
      'trae-qoder: settings API',
    )
    if (!mounted) logger.info?.(`trae-qoder: 设置接口挂在 ${API_PREFIX}`)
  })

  ctx.effect(() => () => {
    try { registration?.() } catch { /* 宿主已在拆卸 */ }
  }, 'trae-qoder: adapter routes')
}

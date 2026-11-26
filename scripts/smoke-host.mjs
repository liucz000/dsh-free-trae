/**
 * Host 半身冒烟测试：假 ctx + 真 http 服务，只跑不联网的接口。
 *
 * 覆盖两条挂载路径：
 *   1. 桌面端（Electron / IPC 桥）：只有 ctx.connection，走共享 /api 精确 Fetch 路由。
 *   2. Web 兜底：只有 ctx.webServer，走 /api/trae-qoder 前缀路由。
 *
 * 运行：node scripts/smoke-host.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tq-smoke-'))

let steps = 0
function ok(name) {
  steps += 1
  console.log(`ok ${steps} - ${name}`)
}

function makeCtx({ withWebServer, withConnection, duplicate = false }) {
  const routes = []
  const fetchRoutes = new Map()
  const disposers = []
  let adapter = null

  const scope = {
    effect(fn) {
      const disposer = fn()
      disposers.push(disposer)
    },
  }
  if (withWebServer) {
    scope.webServer = {
      register(value) {
        if (duplicate) throw new Error(`webserver: duplicate prefix route ${JSON.stringify(value.path)}`)
        routes.push(value)
        return () => {}
      },
    }
  }
  if (withConnection) {
    scope.connection = {
      fetch: {
        register(value) {
          if (duplicate) throw new Error(`connection: exact Fetch route ${JSON.stringify(value.path)} is already registered`)
          fetchRoutes.set(value.path, value)
          return async () => { fetchRoutes.delete(value.path) }
        },
      },
    }
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    llm: {
      registerAdapter(providers, value) {
        assert.deepEqual(providers, ['trae', 'qoder'])
        if (duplicate) throw new Error(`an adapter for provider "${providers[0]}" is already registered`)
        adapter = value
        return () => {}
      },
      registerConfigurableProviders(rows) {
        assert.equal(rows.length, 2)
      },
    },
    inject(deps, callback) {
      const wanted = Array.isArray(deps) ? deps : Object.keys(deps)
      const has = name => (name === 'webServer' && withWebServer) || (name === 'connection' && withConnection)
      if (wanted.every(has)) callback(scope)
    },
    effect(fn) {
      const disposer = fn()
      disposers.push(disposer)
    },
    fiber: { entry: { options: { id: 'trae-qoder' } } },
  }

  apply(ctx, { home })
  if (!duplicate) assert.ok(adapter !== null, '没有注册 LLM 适配器')
  return { routes, fetchRoutes, disposers }
}

// ── 1. 桌面端：只有 connection ────────────────────────────────────────────
const desktop = makeCtx({ withWebServer: false, withConnection: true })
assert.equal(desktop.routes.length, 0, '桌面端不该依赖 webServer')
assert.equal(desktop.fetchRoutes.size, 13, `桌面端应注册 13 条精确路由，实际 ${desktop.fetchRoutes.size}`)

async function callFetch(pathname, { method = 'GET', body } = {}) {
  const route = desktop.fetchRoutes.get(`/api/trae-qoder${pathname.split('?')[0]}`)
  assert.ok(route !== undefined, `没有注册 ${pathname}`)
  assert.ok(route.methods.includes(method), `${pathname} 不接受 ${method}`)
  const response = await route.fetch(new Request(`http://127.0.0.1:1/api/trae-qoder${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  const text = await response.text()
  return { status: response.status, json: text === '' ? null : JSON.parse(text) }
}

const dSummary = await callFetch('/summary')
assert.equal(dSummary.status, 200)
assert.equal(dSummary.json.accounts.trae.length, 0)
assert.equal(dSummary.json.providers.qoder.regions.length, 2)
ok('桌面端 GET /summary')

const dUrl = await callFetch('/trae/login/url', { method: 'POST', body: { region: 'sg' } })
assert.equal(dUrl.status, 200)
assert.ok(dUrl.json.url.startsWith('https://www.trae.ai/authorization?'))
ok('桌面端 POST /trae/login/url')

const dModels = await callFetch('/models?provider=qoder')
assert.equal(dModels.status, 200)
assert.ok(dModels.json.models.length >= 16)
ok('桌面端 GET /models')

const dCredits = await callFetch('/credits')
assert.equal(dCredits.status, 200)
assert.deepEqual(dCredits.json.trae, [])
assert.deepEqual(dCredits.json.qoder, [])
ok('桌面端 GET /credits（空账号）')

const dCheckinBad = await callFetch('/checkin/config', { method: 'POST', body: { enabled: true, time: '25:00' } })
assert.equal(dCheckinBad.status, 400)
ok('桌面端 POST /checkin/config 非法时间 400')

const dCheckin = await callFetch('/checkin/config', { method: 'POST', body: { enabled: false, time: '09:30' } })
assert.equal(dCheckin.status, 200)
assert.equal(dCheckin.json.checkin.time, '09:30')
ok('桌面端 POST /checkin/config')

const dRun = await callFetch('/checkin/run', { method: 'POST', body: {} })
assert.equal(dRun.status, 200)
assert.deepEqual(dRun.json.results, [])
ok('桌面端 POST /checkin/run（空账号）')

const dBad = await callFetch('/trae/login', { method: 'POST', body: { region: 'cn', callbackUrl: '' } })
assert.equal(dBad.status, 400)
ok('桌面端 POST /trae/login 缺回调地址时 400')

const dBadJson = await desktop.fetchRoutes.get('/api/trae-qoder/trae/login/url').fetch(new Request(
  'http://127.0.0.1:1/api/trae-qoder/trae/login/url',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' },
))
assert.equal(dBadJson.status, 400)
ok('桌面端非法 JSON 400')

// ── 2. Web 兜底：只有 webServer ────────────────────────────────────────────
const web = makeCtx({ withWebServer: true, withConnection: false })
const route = web.routes[0]
assert.ok(route !== undefined, '没有注册 webServer 路由')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/api/trae-qoder')
ok('Web 兜底注册前缀路由')

const server = http.createServer(route.handler)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/trae-qoder`

async function call(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? null : JSON.parse(text) }
}

const wSummary = await call('/summary')
assert.equal(wSummary.status, 200)
ok('GET /summary')

const device = await call('/qoder/login/url', { method: 'POST', body: { region: 'global' } })
assert.equal(device.status, 200)
assert.ok(device.json.url.startsWith('https://qoder.com/device/selectAccounts?'))
assert.ok(typeof device.json.sessionId === 'string')
ok('POST /qoder/login/url')

const poll = await call(`/qoder/login/poll?id=${encodeURIComponent('nope')}`)
assert.equal(poll.status, 404)
ok('GET /qoder/login/poll 未知会话 404')

const unknown = await call('/nope')
assert.equal(unknown.status, 404)
ok('未知路由 404')

const preflight = await call('/summary', { method: 'OPTIONS' })
assert.equal(preflight.status, 204)
ok('OPTIONS 预检')

server.close()

// ── 3. 重复实例：provider 与路由都被占用时，激活不能抛错 ──────────────────
const dup = makeCtx({ withWebServer: true, withConnection: true, duplicate: true })
assert.equal(dup.routes.length, 0, '被占用的前缀路由不应重复注册')
assert.equal(dup.fetchRoutes.size, 0, '被占用的精确路由不应重复注册')
ok('重复实例跳过注册且不抛错')

for (const group of [desktop, web, dup]) {
  for (const dispose of group.disposers.reverse()) {
    if (typeof dispose === 'function') dispose()
  }
}
fs.rmSync(home, { recursive: true, force: true })

console.log(`\n冒烟通过（${steps} 项）。`)

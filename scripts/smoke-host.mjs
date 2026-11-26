/**
 * Host 半身冒烟测试：假 ctx + 真 http 服务，只跑不联网的接口。
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
let route = null
let adapter = null
let disposers = []

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  llm: {
    registerAdapter(providers, value) {
      assert.deepEqual(providers, ['trae', 'qoder'])
      adapter = value
      return () => {}
    },
    registerConfigurableProviders(rows) {
      assert.equal(rows.length, 2)
    },
  },
  inject(_deps, callback) {
    callback({
      webServer: {
        register(value) {
          route = value
          return () => {}
        },
      },
      effect(fn) {
        const disposer = fn()
        disposers.push(disposer)
      },
    })
  },
  effect(fn) {
    const disposer = fn()
    disposers.push(disposer)
  },
  fiber: { entry: { options: { id: 'trae-qoder' } } },
}

apply(ctx, { home })
assert.ok(route !== null, '没有注册 webServer 路由')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/api/trae-qoder')
assert.ok(adapter !== null)

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
  return { status: response.status, json: text === '' ? null : JSON.parse(text), headers: response.headers }
}

let steps = 0
function ok(name) {
  steps += 1
  console.log(`ok ${steps} - ${name}`)
}

const summary = await call('/summary')
assert.equal(summary.status, 200)
assert.equal(summary.json.accounts.trae.length, 0)
assert.equal(summary.json.providers.trae.regions.length, 2)
ok('GET /summary')

const traeUrl = await call('/trae/login/url', { method: 'POST', body: { region: 'cn' } })
assert.equal(traeUrl.status, 200)
assert.ok(traeUrl.json.url.startsWith('https://www.trae.cn/authorization?'))
assert.ok(traeUrl.json.url.includes('client_id=en1oxy7wnw8j9n'))
assert.ok(traeUrl.json.url.includes('auth_callback_url=http%3A%2F%2F127.0.0.1%3A18080%2Fauthorize'))
ok('POST /trae/login/url')

const badTrae = await call('/trae/login', { method: 'POST', body: { region: 'cn', callbackUrl: '' } })
assert.equal(badTrae.status, 400)
ok('POST /trae/login 缺回调地址时 400')

const badPat = await call('/qoder/login/pat', { method: 'POST', body: { region: 'cn', pat: '  ' } })
assert.equal(badPat.status, 400)
ok('POST /qoder/login/pat 空 PAT 时 400')

const device = await call('/qoder/login/url', { method: 'POST', body: { region: 'global' } })
assert.equal(device.status, 200)
assert.ok(device.json.url.startsWith('https://qoder.com/device/selectAccounts?'))
assert.ok(device.json.url.includes('challenge_method=S256'))
assert.ok(typeof device.json.sessionId === 'string')
ok('POST /qoder/login/url')

const poll = await call(`/qoder/login/poll?id=${encodeURIComponent('nope')}`)
assert.equal(poll.status, 404)
ok('GET /qoder/login/poll 未知会话 404')

const models = await call('/models?provider=qoder')
assert.equal(models.status, 200)
assert.ok(models.json.models.length >= 16)
assert.ok(models.json.models.some(model => model.id === 'auto'))
ok('GET /models')

const unknown = await call('/nope')
assert.equal(unknown.status, 404)
ok('未知路由 404')

const preflight = await call('/summary', { method: 'OPTIONS' })
assert.equal(preflight.status, 204)
ok('OPTIONS 预检')

server.close()
for (const dispose of disposers.reverse()) {
  if (typeof dispose === 'function') dispose()
}
fs.rmSync(home, { recursive: true, force: true })

console.log(`\n冒烟通过（${steps} 项）。`)

/**
 * 离线自检：不发任何网络请求，只验证纯计算与结构。
 *
 * 运行：node scripts/selftest.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { selfCheck, encodeBody, swapOuterThirds, md5Hex, COSY_SIGNED_PATH } from '../src/qoder/cosy.js'
import { parseCallbackUrl } from '../src/trae/auth.js'
import { prepareBody as traePrepareBody } from '../src/trae/upstream.js'
import { prepareBody as qoderPrepareBody } from '../src/qoder/upstream.js'
import { resolveModel as qoderResolve, BUILTIN } from '../src/qoder/models.js'
import { priceFactorFor } from '../src/trae/models.js'
import { HarnessEmitter, mapFinish, mapUsage } from '../src/emit.js'
import { createStore, publicAccount } from '../src/store.js'
import { readSse } from '../src/http.js'
import { priceBadge } from '../src/adapter.js'
import {
  checkinSucceeded,
  deviceIdFor,
  marketUserIdFor,
  parseCheckinStatus as parseTraeCheckin,
  parseCredits as parseTraeCredits,
  sessionIdFor,
} from '../src/trae/credits.js'
import {
  parseCampaigns,
  parseClaim,
  parseCredits as parseQoderCredits,
} from '../src/qoder/credits.js'
import { isCheckinDue, localDay, normalizeTime, parseMinutes } from '../src/checkin.js'

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

test('cosy 自检（base64/换位/RSA/AES/签名）', () => {
  assert.equal(selfCheck(), true)
})

test('换位是自反的', () => {
  const raw = Buffer.from('0123456789abcdef', 'ascii')
  assert.deepEqual(swapOuterThirds(swapOuterThirds(raw)), raw)
  assert.equal(encodeBody(Buffer.from('abc', 'ascii')).length, 4)
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.ok(COSY_SIGNED_PATH.startsWith('/api/v2/'))
})

test('TRAE 回调解析', () => {
  const userInfo = encodeURIComponent(JSON.stringify({ UserID: 'u-1', ScreenName: 'Alice' }))
  const url = `http://127.0.0.1:18080/authorize?refreshToken=rt-123&userInfo=${userInfo}&authCodeInfo=%7B%22code%22%3A%22c1%22%7D`
  const parsed = parseCallbackUrl(url)
  assert.equal(parsed.refreshToken, 'rt-123')
  assert.equal(parsed.uid, 'u-1')
  assert.equal(parsed.nickname, 'Alice')
  assert.equal(parsed.authCode, 'c1')
})

test('TRAE 请求体改写', () => {
  const body = traePrepareBody({
    model: 'DeepSeek-V4-Flash',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'assistant', content: 'hi', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
    ],
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'f' } },
  })
  assert.equal(body.stream, true)
  assert.equal(body.function, 'solo_work_remote')
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'be brief' }])
  assert.equal(body.messages[1].tool_calls[0].function_call.name, 'f')
  assert.equal(body.messages[1].tool_calls[0].function, undefined)
  assert.equal(typeof body.tools[0].function.parameters, 'string')
  assert.equal(body.tool_choice, 'f')
})

test('Qoder 模型解析', () => {
  assert.equal(qoderResolve('auto').id, 'auto')
  assert.equal(qoderResolve('DeepSeek-V4-Flash').id, 'dfmodel')
  assert.equal(qoderResolve('Kimi-K3').id, 'kmodel_latest')
  assert.equal(qoderResolve('unknown-x').id, 'unknown-x')
  assert.equal(qoderResolve('').id, 'auto')
  assert.ok(BUILTIN.some(entry => entry.id === 'qmodel_38max'))
})

test('Qoder 请求体结构', () => {
  const account = { uid: 'u-1', region: 'cn', organizationId: 'org', organizationTags: ['t'], dataPolicyAgreed: true }
  const body = qoderPrepareBody({
    model: 'auto',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ],
    tools: [{ type: 'function', function: { name: 'f', description: '', parameters: '{"type":"object"}' } }],
    max_tokens: 100,
    reasoning_effort: 'minimal',
    temperature: 0.2,
  }, account)
  assert.equal(body.business.product, 'cli')
  assert.equal(body.business.version, '1.1.74')
  assert.equal(body.model_config.key, 'auto')
  assert.equal(body.model_config.is_reasoning, false)
  assert.equal(body.system, 'sys')
  assert.equal(body.messages[0].role, 'user')
  assert.ok(body.messages[0].contents[0].cache_control !== undefined)
  assert.equal(body.parameters.max_tokens, 100)
  assert.equal(body.parameters.reasoning_effort, 'low')
  assert.equal(body.parameters.temperature, 0.2)
  assert.equal(body.tools.length, 1)
  assert.equal(body.stream, true)
  assert.equal(body.session_id.length, 36)
})

test('块事件发射与收尾', () => {
  const emitter = new HarnessEmitter()
  emitter.text('he')
  emitter.text('llo')
  emitter.toolCall({ index: 0, id: 'c1', name: 'f', arguments: '{"a"' })
  emitter.toolCall({ index: 0, arguments: ':1}' })
  emitter.setUsage({ prompt_tokens: 3, completion_tokens: 4 })
  emitter.setFinish('stop')
  const events = emitter.close()
  assert.deepEqual(emitter.drain(), [])
  const kinds = events.map(event => event.type)
  assert.ok(kinds.includes('block-start'))
  assert.ok(kinds.includes('text-delta'))
  assert.ok(kinds.includes('tool-call-delta'))
  const toolEnd = events.find(event => event.type === 'block-end' && event.block.type === 'tool-call')
  assert.equal(toolEnd.block.arguments, '{"a":1}')
  assert.equal(toolEnd.block.name, 'f')
  assert.deepEqual(mapFinish('stop', true), { kind: 'tool-calls' })
  assert.deepEqual(mapFinish('length', false), { kind: 'max-tokens' })
  assert.deepEqual(mapUsage({ input_tokens: 2, output_tokens: 5 }), { inputTokens: 2, outputTokens: 5, totalTokens: 7 })
})

test('账号库读写与掩码', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tq-'))
  const store = createStore({ home })
  const account = {
    id: 'trae-u1', uid: 'u1', name: 'Alice', region: 'cn',
    accessToken: 'at-secret', refreshToken: 'rt-secret', expiresAt: Date.now() + 3600_000,
  }
  store.add('trae', account)
  assert.equal(store.current('trae').id, 'trae-u1')
  assert.equal(store.list('trae').length, 1)
  const masked = publicAccount('trae', store.list('trae')[0])
  assert.equal(masked.accessToken, undefined)
  assert.equal(masked.refreshToken, undefined)
  assert.equal(masked.refreshable, true)
  const mode = fs.statSync(store.file).mode & 0o777
  assert.equal(mode, 0o600)
  assert.equal(store.remove('trae', 'trae-u1'), true)
  assert.equal(store.current('trae'), null)
  fs.rmSync(home, { recursive: true, force: true })
})

test('SSE 解析', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: output\ndata: {"a":1}\n\n'))
      controller.enqueue(encoder.encode('data: line1\ndata: line2\n\n'))
      controller.close()
    },
  })
  const frames = []
  for await (const frame of readSse({ body: stream })) frames.push(frame)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].event, 'output')
  assert.equal(frames[0].data, '{"a":1}')
  assert.equal(frames[1].data, 'line1\nline2')
})

test('签到设置读写', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tq-set-'))
  const store = createStore({ home })
  assert.equal(store.settings().checkin.trae.enabled, false)
  assert.equal(store.settings().checkin.qoder.time, '09:00')
  const next = store.updateSettings({ checkin: { trae: { enabled: true, time: '08:30' } } })
  assert.equal(next.checkin.trae.enabled, true)
  assert.equal(next.checkin.trae.time, '08:30')
  assert.equal(next.checkin.qoder.enabled, false)
  assert.equal(store.settings().checkin.trae.time, '08:30')
  assert.equal(fs.statSync(store.settingsFile).mode & 0o777, 0o600)
  // 旧版扁平结构读入时迁移成两渠道各一份。
  fs.writeFileSync(store.settingsFile, JSON.stringify({ checkin: { enabled: true, time: '07:10', lastDay: '2026-01-02' } }))
  const fresh = createStore({ home })
  assert.equal(fresh.settings().checkin.trae.enabled, true)
  assert.equal(fresh.settings().checkin.qoder.time, '07:10')
  fs.rmSync(home, { recursive: true, force: true })
})

test('TRAE 设备身份派生', () => {
  const one = deviceIdFor('u-1')
  assert.match(one, /^\d{15}$/)
  assert.equal(deviceIdFor('u-1'), one)
  assert.notEqual(deviceIdFor('u-2'), one)
  assert.match(sessionIdFor('u-1'), /^[0-9a-f]{64}$/)
  assert.match(marketUserIdFor('u-1'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('TRAE 积分与签到解析', () => {
  assert.deepEqual(
    parseTraeCredits({ usage_summary: { total_amount: 100, consumed_amount: 40 } }),
    { remaining: 60, exceeded: false },
  )
  assert.equal(parseTraeCredits({ usage_summary: {} }), null)
  assert.equal(parseTraeCredits({}), null)
  assert.deepEqual(
    parseTraeCheckin({ checked_in: true, credits: 150, enable: true }),
    { checkedIn: true, credits: 150, enable: true },
  )
  assert.equal(parseTraeCheckin({ code: 1001, enable: false }), null)
  assert.equal(checkinSucceeded({ checkedIn: false }, { checkedIn: true }, 0), true)
  assert.equal(checkinSucceeded({ checkedIn: true }, { checkedIn: true }, 0), false)
  assert.equal(checkinSucceeded({ checkedIn: false }, { checkedIn: true }, 9004), false)
  assert.equal(checkinSucceeded({ checkedIn: false }, null, 0), false)
})

test('Qoder 积分与活动解析', () => {
  assert.deepEqual(parseQoderCredits({
    userQuota: { remaining: 10 },
    personalQuota: { remaining: 5 },
    addOnQuota: { remaining: 2 },
    isQuotaExceeded: false,
  }), { remaining: 17, exceeded: false })
  assert.deepEqual(
    parseQoderCredits({ data: { organizationQuota: { remaining: 3, available: true } } }),
    { remaining: 3, exceeded: false },
  )
  assert.deepEqual(
    parseQoderCredits({ organizationQuota: { remaining: 3, available: false } }),
    { remaining: 0, exceeded: false },
  )

  const list = parseCampaigns({ campaigns: [
    { campaignId: 'c1', claimStatus: 'claimable', benefit: { kind: 'CREDITS', amount: 100 } },
    { campaignKey: 'c2', claimStatus: 'CLAIMED', benefit: null },
  ] })
  assert.equal(list.campaigns.length, 2)
  assert.equal(list.campaigns[0].claimable, true)
  assert.equal(list.campaigns[0].grantsCredits, true)
  assert.equal(list.campaigns[1].claimStatus, 'CLAIMED')
  assert.equal(list.campaigns[1].benefitAmount, 0)

  assert.deepEqual(
    parseClaim({ status: 'CLAIMED', benefit: { amount: 100 } }),
    { newly: true, amount: 100, status: 'CLAIMED' },
  )
  assert.deepEqual(
    parseClaim({ status: 'CLAIMED', replayed: true, benefit: { amount: 100 } }),
    { newly: false, amount: 0, status: 'CLAIMED' },
  )
})

test('签到时间与到期判定', () => {
  assert.equal(normalizeTime('9:05'), '09:05')
  assert.equal(normalizeTime('23:59'), '23:59')
  assert.equal(normalizeTime('24:00'), null)
  assert.equal(normalizeTime('oops'), null)
  assert.equal(parseMinutes('09:30'), 570)
  const now = new Date(2026, 0, 2, 10, 0, 0)
  assert.equal(localDay(now), '2026-01-02')
  assert.equal(isCheckinDue({ enabled: true, time: '09:00', lastDay: '' }, now), true)
  assert.equal(isCheckinDue({ enabled: true, time: '09:00', lastDay: '2026-01-02' }, now), false)
  assert.equal(isCheckinDue({ enabled: true, time: '11:00', lastDay: '' }, now), false)
  assert.equal(isCheckinDue({ enabled: false, time: '09:00', lastDay: '' }, now), false)
})

test('Qoder 模型倍率标签', () => {
  assert.deepEqual(priceBadge(0), { text: '免费', tone: 'success' })
  assert.deepEqual(priceBadge(0.5), { text: '×0.5', tone: 'info' })
  assert.deepEqual(priceBadge(8), { text: '×8', tone: 'info' })
  assert.equal(priceBadge(null), undefined)
  assert.equal(priceBadge(undefined), undefined)
})

test('TRAE 官方积分消耗速度表', () => {
  assert.equal(priceFactorFor('Seed-2.1-Turbo'), 0.4)
  assert.equal(priceFactorFor('seed-code'), 0.12)
  assert.equal(priceFactorFor('DeepSeek-V4.1-Flash'), 0.12)
  assert.equal(priceFactorFor('DeepSeek-V4-Pro'), 0.72)
  assert.equal(priceFactorFor('GLM-5.3'), 0.78)
  assert.equal(priceFactorFor('Kimi-K3'), null)
  assert.equal(priceFactorFor(''), null)
})

console.log(`\n全部通过（${passed} 项）。`)

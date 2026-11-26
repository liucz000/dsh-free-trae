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
import { HarnessEmitter, mapFinish, mapUsage } from '../src/emit.js'
import { createStore, publicAccount } from '../src/store.js'
import { readSse } from '../src/http.js'

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

console.log(`\n全部通过（${passed} 项）。`)

/**
 * 账号库：~/.dsh/trae-qoder/accounts.json（0600）。
 *
 * 只存 TRAE / Qoder 两个 provider 的账号。token 全部落在这个文件里，
 * 不上传、不打日志；HTTP 接口只返回掩码后的视图。
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PROVIDERS = ['trae', 'qoder']

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

function emptyState() {
  return { version: 1, active: { trae: '', qoder: '' }, trae: [], qoder: [] }
}

function normalizeState(value) {
  const state = emptyState()
  if (value === null || typeof value !== 'object') return state
  for (const provider of PROVIDERS) {
    const rows = Array.isArray(value[provider]) ? value[provider] : []
    state[provider] = rows.filter(row => row !== null && typeof row === 'object' && typeof row.id === 'string')
  }
  const active = value.active !== null && typeof value.active === 'object' ? value.active : {}
  for (const provider of PROVIDERS) {
    const id = typeof active[provider] === 'string' ? active[provider] : ''
    state.active[provider] = state[provider].some(row => row.id === id) ? id : (state[provider][0]?.id ?? '')
  }
  return state
}

/** 账号响应里绝不能出现 token / pat。 */
export function publicAccount(provider, account) {
  return {
    id: account.id,
    provider,
    uid: account.uid ?? '',
    name: account.name ?? account.nickname ?? '',
    region: account.region ?? '',
    expiresAt: Number(account.expiresAt ?? 0),
    addedAt: Number(account.addedAt ?? 0),
    refreshable: typeof account.refreshToken === 'string' && account.refreshToken !== ''
      || typeof account.jobRefreshToken === 'string' && account.jobRefreshToken !== ''
      || typeof account.pat === 'string' && account.pat !== '',
  }
}

export function createStore({ home = resolveDshHome(), dirName = 'trae-qoder' } = {}) {
  const dir = path.join(home, dirName)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'accounts.json')
  let cache = null

  function read() {
    if (cache !== null) return cache
    try {
      const text = fs.readFileSync(file, 'utf8')
      cache = normalizeState(JSON.parse(text))
    } catch {
      cache = emptyState()
    }
    return cache
  }

  function write(next) {
    cache = normalizeState(next)
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* Windows 上无 POSIX 权限位 */ }
    return cache
  }

  function list(provider) {
    const state = read()
    return PROVIDERS.includes(provider) ? state[provider].slice() : []
  }

  function current(provider) {
    const state = read()
    const rows = state[provider] ?? []
    return rows.find(row => row.id === state.active[provider]) ?? rows[0] ?? null
  }

  function add(provider, account) {
    if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"`)
    const state = read()
    const rows = state[provider]
    const now = Date.now()
    const incoming = { ...account, addedAt: Number(account.addedAt ?? now) }
    // 同一账号重复登录时覆盖 token，而不是堆出第二条。
    const index = rows.findIndex(row => row.id === incoming.id)
    if (index >= 0) rows[index] = { ...rows[index], ...incoming, addedAt: rows[index].addedAt ?? now }
    else rows.push(incoming)
    state.active[provider] = incoming.id
    write(state)
    return rows.find(row => row.id === incoming.id)
  }

  function update(provider, id, patch) {
    if (!PROVIDERS.includes(provider)) return null
    const state = read()
    const row = state[provider].find(item => item.id === id)
    if (row === undefined) return null
    Object.assign(row, patch ?? {})
    write(state)
    return row
  }

  function remove(provider, id) {
    if (!PROVIDERS.includes(provider)) return false
    const state = read()
    const before = state[provider].length
    state[provider] = state[provider].filter(row => row.id !== id)
    if (state[provider].length === before) return false
    if (state.active[provider] === id) state.active[provider] = state[provider][0]?.id ?? ''
    write(state)
    return true
  }

  function select(provider, id) {
    if (!PROVIDERS.includes(provider)) return false
    const state = read()
    if (!state[provider].some(row => row.id === id)) return false
    state.active[provider] = id
    write(state)
    return true
  }

  function snapshot() {
    return {
      active: { ...read().active },
      trae: read().trae.map(row => publicAccount('trae', row)),
      qoder: read().qoder.map(row => publicAccount('qoder', row)),
    }
  }

  return { dir, file, read, write, list, current, add, update, remove, select, snapshot }
}

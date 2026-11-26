/**
 * 账号库：~/.dsh/free-trae/accounts.json（0600）。
 *
 * 只存 TRAE 一个 provider 的账号。token 全部落在这个文件里，
 * 不上传、不打日志；HTTP 接口只返回掩码后的视图。
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PROVIDERS = ['trae']

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

function emptyState() {
  return { version: 1, active: { trae: '' }, trae: [] }
}

function emptyCheckinState() {
  return {
    enabled: false,
    time: '09:00',
    lastDay: '',
    lastRunAt: 0,
    lastTrigger: '',
    lastResults: [],
  }
}

function emptySettings() {
  return { version: 1, checkin: { trae: emptyCheckinState() } }
}

function normalizeCheckinState(value) {
  const state = emptyCheckinState()
  if (value === null || typeof value !== 'object') return state
  state.enabled = value.enabled === true
  state.time = typeof value.time === 'string' && /^\d{1,2}:\d{2}$/.test(value.time)
    ? value.time
    : '09:00'
  state.lastDay = typeof value.lastDay === 'string' ? value.lastDay : ''
  state.lastRunAt = Number.isFinite(Number(value.lastRunAt)) ? Number(value.lastRunAt) : 0
  state.lastTrigger = typeof value.lastTrigger === 'string' ? value.lastTrigger : ''
  state.lastResults = Array.isArray(value.lastResults)
    ? value.lastResults.filter(row => row !== null && typeof row === 'object')
    : []
  return state
}

function normalizeSettings(value) {
  const settings = emptySettings()
  if (value === null || typeof value !== 'object') return settings
  const checkin = value.checkin
  if (checkin === null || typeof checkin !== 'object') return settings
  // 旧版是单个扁平对象；读到时迁移成 trae 这一份。
  if (!('trae' in checkin)) {
    settings.checkin = { trae: normalizeCheckinState(checkin) }
    return settings
  }
  settings.checkin.trae = normalizeCheckinState(checkin.trae)
  return settings
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

export function createStore({ home = resolveDshHome(), dirName = 'free-trae' } = {}) {
  const dir = path.join(home, dirName)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'accounts.json')
  const settingsFile = path.join(dir, 'settings.json')
  let cache = null
  let settingsCache = null

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
    }
  }

  function readSettings() {
    if (settingsCache !== null) return settingsCache
    try {
      settingsCache = normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8')))
    } catch {
      settingsCache = emptySettings()
    }
    return settingsCache
  }

  function writeSettings(next) {
    settingsCache = normalizeSettings(next)
    const tmp = `${settingsFile}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(settingsCache, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, settingsFile)
    try { fs.chmodSync(settingsFile, 0o600) } catch { /* Windows 上无 POSIX 权限位 */ }
    return settingsCache
  }

  /** 只读快照（深拷贝，调用方改不动缓存）。 */
  function settings() {
    return JSON.parse(JSON.stringify(readSettings()))
  }

  /** 合并写入；`checkin` 按渠道覆盖传入的键。 */
  function updateSettings(patch) {
    const current = readSettings()
    const checkinPatch = patch?.checkin ?? {}
    const checkin = {
      trae: { ...current.checkin.trae, ...(checkinPatch.trae ?? {}) },
    }
    return writeSettings({ ...current, ...patch, checkin })
  }

  return {
    dir, file, settingsFile,
    read, write, list, current, add, update, remove, select, snapshot,
    settings, updateSettings,
  }
}

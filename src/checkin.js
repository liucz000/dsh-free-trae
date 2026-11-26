/**
 * 积分查询 / 每日签到的编排与定时调度（Host 侧）。
 *
 *  - {@link collectCredits}：把两个渠道**所有账号**的可用积分各查一遍，单账号失败只影响它自己。
 *  - {@link createCheckinRunner}：手动 / 定时共用的签到执行器（同一时刻只跑一轮）。
 *  - {@link startCheckinScheduler}：60 秒看一次表，到了设定时刻且今天还没跑过就补跑。
 *
 * 签到结果与开关落在 `~/.dsh/trae-qoder/settings.json`（由 store 管理），重启后仍在。
 *
 * @module src/checkin.js
 */

import { ensureFresh as traeEnsureFresh } from './trae/auth.js'
import {
  fetchCredits as traeFetchCredits,
  runCheckin as traeRunCheckin,
} from './trae/credits.js'
import { ensureFresh as qoderEnsureFresh } from './qoder/auth.js'
import {
  fetchCredits as qoderFetchCredits,
  runCheckin as qoderRunCheckin,
} from './qoder/credits.js'

const PROVIDERS = ['trae', 'qoder']
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

function textOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** `H:mm` / `HH:mm` → `HH:mm`；非法返回 null。 */
export function normalizeTime(value, fallback = null) {
  const text = String(value ?? '').trim()
  const match = TIME_RE.exec(text)
  if (match === null) return fallback
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

export function parseMinutes(value) {
  const normalized = normalizeTime(value)
  if (normalized === null) return null
  const [hour, minute] = normalized.split(':').map(Number)
  return hour * 60 + minute
}

export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}

export function localDay(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 今天是否该跑：开关开着、今天没跑过、且已到设定时刻（晚了也补跑）。 */
export function isCheckinDue(checkin, now = new Date()) {
  if (checkin?.enabled !== true) return false
  const target = parseMinutes(checkin.time)
  if (target === null) return false
  if (checkin.lastDay === localDay(now)) return false
  return minutesOfDay(now) >= target
}

function freshFor(provider, account, store, signal) {
  const options = { store, signal }
  return provider === 'trae'
    ? traeEnsureFresh(account, options)
    : qoderEnsureFresh(account, options)
}

function checkinFor(provider, account, signal) {
  return provider === 'trae'
    ? traeRunCheckin(account, { signal })
    : qoderRunCheckin(account, { signal })
}

function creditsFor(provider, account, signal) {
  return provider === 'trae'
    ? traeFetchCredits(account, { signal })
    : qoderFetchCredits(account, { signal })
}

/**
 * 查询全部账号的积分。
 * @returns {{at:number, trae:Array, qoder:Array}}
 */
export async function collectCredits({ store, signal } = {}) {
  const out = { at: Date.now(), trae: [], qoder: [] }
  for (const provider of PROVIDERS) {
    for (const row of store.list(provider)) {
      if (provider === 'trae' && row.region !== 'cn') {
        out.trae.push({
          id: row.id, name: row.name ?? '', remaining: null, exceeded: false,
          error: 'TRAE 国际服暂不支持积分查询', at: Date.now(),
        })
        continue
      }
      try {
        const account = await freshFor(provider, row, store, signal)
        const value = await creditsFor(provider, account, signal)
        out[provider].push({
          id: row.id, name: row.name ?? '',
          remaining: value.remaining, exceeded: value.exceeded === true,
          error: '', at: Date.now(),
        })
      } catch (error) {
        out[provider].push({
          id: row.id, name: row.name ?? '', remaining: null, exceeded: false,
          error: textOf(error), at: Date.now(),
        })
      }
    }
  }
  out.at = Date.now()
  return out
}

/** 对指定渠道（默认两个渠道）的全部账号各跑一次签到；单个账号失败不影响其它。 */
export async function runAllCheckins({ store, logger, signal, providers = PROVIDERS } = {}) {
  const results = []
  for (const provider of providers) {
    if (!PROVIDERS.includes(provider)) continue
    for (const row of store.list(provider)) {
      const base = { provider, id: row.id, name: row.name ?? row.uid ?? row.id }
      if (provider === 'trae' && row.region !== 'cn') {
        results.push({ ...base, status: 'unsupported', amount: 0, message: 'TRAE 国际服暂不支持签到' })
        continue
      }
      try {
        const account = await freshFor(provider, row, store, signal)
        const result = await checkinFor(provider, account, signal)
        results.push({ ...base, ...result })
      } catch (error) {
        logger?.warn?.(`[trae-qoder] ${provider} 签到失败（${base.name}）：${textOf(error)}`)
        results.push({ ...base, status: 'fail', amount: 0, message: textOf(error) })
      }
    }
  }
  return results
}

/**
 * 签到执行器：手动与定时共用，同一时刻只允许一轮。
 * 跑完把 lastRunAt / lastDay / lastResults 写进 settings.json。
 */
export function createCheckinRunner({ store, logger }) {
  let pending = null

  async function run({ trigger = 'manual', providers = PROVIDERS } = {}) {
    if (pending !== null) return pending
    const wanted = [...new Set(providers)].filter(provider => PROVIDERS.includes(provider))
    pending = (async () => {
      const results = await runAllCheckins({ store, logger, providers: wanted })
      const at = Date.now()
      const current = store.settings().checkin
      const checkin = {}
      for (const provider of wanted) {
        // 该渠道没有账号时不动它的记录（免得把「今天已签」标在一个空渠道上）。
        if (store.list(provider).length === 0) continue
        const own = results.filter(row => row.provider === provider)
        checkin[provider] = {
          lastRunAt: at,
          lastTrigger: trigger,
          lastResults: own,
          lastDay: own.length > 0 ? localDay(new Date(at)) : current[provider].lastDay,
        }
      }
      const next = store.updateSettings({ checkin })
      return { ok: true, at, trigger, results, checkin: next.checkin }
    })()
    try {
      return await pending
    } finally {
      pending = null
    }
  }

  return { run, isBusy: () => pending !== null }
}

/**
 * 定时调度：每 `intervalMs` 看一次表，满足 {@link isCheckinDue} 就跑一轮。
 * 返回停止函数（供 ctx.effect 回收）。
 */
export function startCheckinScheduler({ store, logger, runCheckin, intervalMs = 30_000 }) {
  let ticking = false

  async function tick(trigger) {
    if (ticking) return
    const settings = store.settings().checkin
    // 两个渠道各自判断：只跑到了点且今天没跑过的那一边。
    const due = PROVIDERS.filter(provider => isCheckinDue(settings[provider]))
    if (due.length === 0) return
    ticking = true
    try {
      logger?.info?.(`[trae-qoder] 定时签到开始：${due.join(', ')}`)
      await runCheckin({ trigger, providers: due })
    } catch (error) {
      logger?.warn?.(`[trae-qoder] 定时签到失败：${textOf(error)}`)
    } finally {
      ticking = false
    }
  }

  const timer = setInterval(() => { void tick('schedule') }, intervalMs)
  timer.unref?.()
  // 启动时补一次：DSH 重启后如果今天还没签，不用等到下一个整点。
  void tick('startup')

  return () => clearInterval(timer)
}

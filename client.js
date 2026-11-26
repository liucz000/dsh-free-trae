/**
 * dsh-trae-qoder — 浏览器半身。
 *
 * 在设置页注册一个 "TRAE / Qoder" 分区，两张卡：
 *   TRAE  : 选区域 → 生成授权链接 → 粘贴回调地址 → 完成登录
 *   Qoder : 选区域 → 粘贴 PAT，或走浏览器设备授权（自动轮询）
 *
 * 数据全部走同源 `/api/trae-qoder/*`，不直接碰 token 之外的宿主 API。
 * 颜色只用宿主的 dsw-alias 主题变量，跟随亮/暗色。
 *
 * @module dsh-trae-qoder/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-trae-qoder',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    // Web 走同源相对路径；桌面端页面是 file://，必须用绝对 /api 路径交给 IPC 桥。
    const API = /^https?:/i.test(document.baseURI)
      ? new URL('api/trae-qoder', document.baseURI).pathname.replace(/\/$/, '')
      : '/api/trae-qoder'
    const NS = 'settings.traeQoder'
    const POLL_MS = 1500
    const DEVICE_TTL_MS = 5 * 60_000

    async function api(path, { method = 'GET', body } = {}) {
      const response = await fetch(`${API}${path}`, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let data
      try {
        data = text === '' ? {} : JSON.parse(text)
      } catch {
        data = { error: text.slice(0, 200) }
      }
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
      return data
    }

    const S = {
      page: { display: 'grid', gap: '16px' },
      grid: { display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' },
      card: {
        display: 'grid',
        gap: '12px',
        padding: '16px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1, #d9d9e3)',
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1b1b1f)',
      },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      hint: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #666)' },
      subtle: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      input: {
        flex: '1 1 180px',
        minWidth: '140px',
        padding: '7px 9px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #d9d9e3)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7fa)',
        color: 'var(--dsw-alias-label-primary, #1b1b1f)',
        font: 'inherit',
      },
      select: {
        padding: '7px 9px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #d9d9e3)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7fa)',
        color: 'var(--dsw-alias-label-primary, #1b1b1f)',
        font: 'inherit',
      },
      button: {
        padding: '7px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #d9d9e3)',
        background: 'var(--dsw-alias-bg-layer-3, #f0f0f5)',
        color: 'var(--dsw-alias-label-primary, #1b1b1f)',
        font: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        padding: '7px 12px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-state-business-primary, #6c5ce7)',
        color: 'var(--dsw-alias-label-on-accent, #ffffff)',
        font: 'inherit',
        cursor: 'pointer',
      },
      ghost: {
        padding: '5px 10px',
        borderRadius: '8px',
        border: '1px dashed var(--dsw-alias-border-l1, #d9d9e3)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #666)',
        font: 'inherit',
        cursor: 'pointer',
      },
      account: {
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #e7e7ee)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7fa)',
      },
      accountText: { display: 'grid', gap: '2px', minWidth: 0 },
      nameLine: { display: 'flex', gap: '6px', alignItems: 'center', minWidth: 0, flexWrap: 'wrap' },
      name: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      stats: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      stat: {
        display: 'grid',
        gap: '1px',
        minWidth: '84px',
        padding: '6px 9px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #e7e7ee)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7fa)',
      },
      statLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #888)' },
      statValue: { fontSize: '13px', fontWeight: 600 },
      pill: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3, #f0f0f5)',
        color: 'var(--dsw-alias-label-secondary, #666)',
      },
      pillOk: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3, #f0f0f5)',
        color: 'var(--dsw-alias-state-success-primary, #12a150)',
      },
      pillBad: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3, #f0f0f5)',
        color: 'var(--dsw-alias-state-error-primary, #d33)',
      },
      divider: { height: '1px', background: 'var(--dsw-alias-border-l2, #e7e7ee)' },
      subTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
      tag: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-3, #f0f0f5)',
        color: 'var(--dsw-alias-label-secondary, #666)',
      },
      notice: {
        margin: 0,
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #d9d9e3)',
        fontSize: '12px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary, #666)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7fa)',
        wordBreak: 'break-all',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, #d33)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px', wordBreak: 'break-all' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' },
    }

    function RegionSelect({ value, onChange, regions }) {
      return h('select', { style: S.select, value, onChange: event => onChange(event.target.value) },
        regions.map(region => h('option', { key: region.id, value: region.id }, region.label)),
      )
    }

    function formatCredits(item) {
      if (item === undefined || item === null) return '—'
      if (item.error) return `—（${item.error}）`
      const value = Number(item.remaining)
      if (!Number.isFinite(value)) return '—'
      return Number.isInteger(value) ? String(value) : value.toFixed(1)
    }

    function creditsOf(credits, provider, id) {
      const rows = credits?.[provider]
      return Array.isArray(rows) ? rows.find(row => row.id === id) : undefined
    }

    function creditsTotal(credits, provider) {
      const rows = credits?.[provider]
      if (!Array.isArray(rows) || rows.length === 0) return null
      const known = rows.filter(row => row.error === '' && Number.isFinite(Number(row.remaining)))
      if (known.length === 0) return '—'
      const sum = known.reduce((total, row) => total + Number(row.remaining), 0)
      return Number.isInteger(sum) ? String(sum) : sum.toFixed(1)
    }

    function checkinLabel(row, short = false) {
      if (row.status === 'ok') return row.amount > 0 ? `✓ 领取成功 +${row.amount}` : `✓ ${row.message || '已领取'}`
      if (row.status === 'already') return short ? '今日已签' : (row.message || '今日已领取')
      if (row.status === 'pending') return short ? '待刷新' : (row.message || '待刷新')
      if (row.status === 'ineligible') return short ? '无资格' : (row.message || '无领取资格')
      if (row.status === 'unsupported') return short ? '不支持' : (row.message || '不支持')
      return short ? '失败' : `失败：${row.message || '未知错误'}`
    }

    function formatTime(timestamp) {
      const value = Number(timestamp)
      if (!Number.isFinite(value) || value <= 0) return ''
      return new Date(value).toLocaleString()
    }

    function expiryText(row) {
      const at = Number(row.expiresAt ?? 0)
      if (!Number.isFinite(at) || at <= 0) return '长期有效'
      if (at <= Date.now()) return 'token 已过期'
      const date = new Date(at)
      const pad = value => String(value).padStart(2, '0')
      return `到期 ${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function checkinResultOf(checkin, accountId) {
      const rows = Array.isArray(checkin?.lastResults) ? checkin.lastResults : []
      return rows.find(row => row.id === accountId)
    }

    function Stats({ provider, accounts, credits, checkin }) {
      const total = creditsTotal(credits, provider)
      const results = Array.isArray(checkin?.lastResults) ? checkin.lastResults : []
      const done = results.filter(row => row.status === 'ok' || row.status === 'already').length
      return h('div', { style: S.stats },
        h('div', { style: S.stat },
          h('span', { style: S.statLabel }, '账号'),
          h('span', { style: S.statValue }, String(accounts.length)),
        ),
        h('div', { style: S.stat },
          h('span', { style: S.statLabel }, '积分合计'),
          h('span', { style: S.statValue }, total ?? '—'),
        ),
        h('div', { style: S.stat },
          h('span', { style: S.statLabel }, '上次签到'),
          h('span', { style: S.statValue }, results.length === 0 ? '—' : `${done}/${results.length}`),
        ),
      )
    }

    function AccountRows({ provider, rows, activeId, credits, creditsLoading, checkin, onSelect, onRemove, onRefresh, busy }) {
      if (rows.length === 0) return h('p', { style: S.hint }, '还没有账号。')
      return h('div', { style: { display: 'grid', gap: '8px' } },
        rows.map(row => {
          const item = creditsOf(credits, provider, row.id)
          const creditsText = item === undefined && creditsLoading ? '查询中…' : formatCredits(item)
          const result = checkinResultOf(checkin, row.id)
          const tone = result === undefined
            ? S.pill
            : (result.status === 'ok' || result.status === 'already'
              ? S.pillOk
              : (result.status === 'pending' || result.status === 'ineligible' ? S.pill : S.pillBad))
          return h('div', { key: row.id, style: S.account },
            h('div', { style: S.accountText },
              h('div', { style: S.nameLine },
                h('span', { style: S.name }, row.name || row.uid),
                h('span', { style: S.pill }, `积分 ${creditsText}`),
                result !== undefined ? h('span', { style: tone }, checkinLabel(result, true)) : null,
              ),
              h('div', { style: S.subtle },
                row.region === 'cn' ? '国内' : (row.region === 'global' ? '国际' : row.region),
                row.uid ? ` · ${row.uid}` : '',
              ),
              h('div', { style: S.subtle }, expiryText(row), row.refreshable ? ' · 可续期' : ' · 不可续期'),
            ),
            h('div', { style: S.row },
              row.id === activeId ? h('span', { style: S.tag }, '使用中') : null,
              h('button', {
                type: 'button', style: S.ghost, disabled: busy !== '',
                onClick: () => onSelect(provider, row.id),
              }, '设为当前'),
              h('button', {
                type: 'button', style: S.ghost, disabled: busy !== '' || row.refreshable !== true,
                onClick: () => onRefresh(provider, row.id),
              }, '续期'),
              h('button', {
                type: 'button', style: S.ghost, disabled: busy !== '',
                onClick: () => onRemove(provider, row.id),
              }, '移除'),
            ),
          )
        }),
      )
    }

    function CheckinControls({ provider, summary, busy, setBusy, setNotice, reload }) {
      const cfg = summary?.checkin?.[provider] ?? {}
      const label = provider === 'trae' ? 'TRAE' : 'Qoder'
      const [enabled, setEnabled] = useState(cfg.enabled === true)
      const [time, setTime] = useState(typeof cfg.time === 'string' ? cfg.time : '09:00')

      useEffect(() => {
        setEnabled(cfg.enabled === true)
        setTime(typeof cfg.time === 'string' ? cfg.time : '09:00')
      }, [cfg.enabled, cfg.time])

      const saveKey = `${provider}-checkin-save`
      const runKey = `${provider}-checkin-run`

      const save = async () => {
        setBusy(saveKey); setNotice('')
        try {
          await api('/checkin/config', { method: 'POST', body: { provider, enabled, time } })
          setNotice(enabled ? `${label} 已保存：每天 ${time} 自动签到。` : `${label} 已关闭定时签到。`)
          await reload()
        } catch (error) {
          setNotice(`${label} 保存签到设置失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const runNow = async () => {
        setBusy(runKey); setNotice('')
        try {
          const value = await api('/checkin/run', { method: 'POST', body: { provider } })
          const results = (value.results ?? []).filter(row => row.provider === provider)
          const okCount = results.filter(row => row.status === 'ok').length
          setNotice(`${label} 签到完成：${okCount} 个账号领取成功，共 ${results.length} 个账号。`)
          await reload()
        } catch (error) {
          setNotice(`${label} 签到失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const results = Array.isArray(cfg.lastResults) ? cfg.lastResults : []
      const triggerLabel = cfg.lastTrigger === 'schedule' ? '定时' : (cfg.lastTrigger === 'startup' ? '启动补签' : '手动')

      return h('div', { style: { display: 'grid', gap: '8px' } },
        h('div', { style: S.head },
          h('h4', { style: S.subTitle }, `${label} 每日签到`),
          h('label', { style: S.row },
            h('input', {
              type: 'checkbox', checked: enabled, disabled: busy !== '',
              onChange: event => setEnabled(event.target.checked),
            }),
            h('span', { style: S.subtle }, enabled ? `每天 ${time}` : '定时关'),
          ),
        ),
        h('p', { style: S.hint }, provider === 'trae'
          ? '只对 TRAE 国服生效；国际服会显示「不支持」。开启后 DSH 需保持运行。'
          : '每天领取 Qoder 活动 Credits；上游没活动时会显示「今日无可领活动」。'),
        h('div', { style: S.row },
          h('input', {
            type: 'time', style: { ...S.input, flex: '0 1 120px', minWidth: '110px' },
            value: time, disabled: busy !== '',
            onChange: event => setTime(event.target.value),
          }),
          h('button', { type: 'button', style: S.button, disabled: busy !== '', onClick: save },
            busy === saveKey ? '保存中…' : '保存'),
          h('button', { type: 'button', style: S.primary, disabled: busy !== '', onClick: runNow },
            busy === runKey ? '签到中…' : '立即签到'),
        ),
        cfg.lastRunAt
          ? h('p', { style: S.hint }, `上次运行：${formatTime(cfg.lastRunAt)}（${triggerLabel}）`)
          : h('p', { style: S.hint }, '还没有运行过。'),
        results.length > 0
          ? h('div', { style: { display: 'grid', gap: '2px' } },
              results.map((row, index) => h('div', { key: `${row.id}-${index}`, style: S.subtle },
                `${row.name || row.id || '账号'}：${checkinLabel(row)}`,
              )),
            )
          : null,
      )
    }

    function TraeCard({ summary, credits, creditsLoading, busy, setBusy, setNotice, reload }) {
      const regions = summary?.providers?.trae?.regions ?? [{ id: 'cn', label: 'TRAE 国服（trae.cn）' }]
      const [region, setRegion] = useState(regions[0]?.id ?? 'cn')
      const [login, setLogin] = useState(null)
      const [callbackUrl, setCallbackUrl] = useState('')
      const accounts = summary?.accounts?.trae ?? []
      const activeId = summary?.accounts?.active?.trae ?? ''
      const checkin = summary?.checkin?.trae ?? {}

      const start = async () => {
        setBusy('trae-url'); setNotice('')
        try {
          const value = await api('/trae/login/url', { method: 'POST', body: { region } })
          setLogin({ url: value.url })
          setCallbackUrl('')
          try { window.open(value.url, '_blank', 'noopener,noreferrer') } catch { /* 地址已经显示在下面 */ }
        } catch (error) {
          setNotice(`生成登录链接失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const finish = async () => {
        if (callbackUrl.trim() === '') { setNotice('请先粘贴回调地址'); return }
        setBusy('trae-login'); setNotice('')
        try {
          const value = await api('/trae/login', { method: 'POST', body: { region, callbackUrl } })
          setLogin(null); setCallbackUrl('')
          setNotice(`已接入 ${value.account?.name ?? 'TRAE'}。`)
          await reload()
        } catch (error) {
          setNotice(`TRAE 登录失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const act = async (path, body) => {
        setBusy(`trae-act`); setNotice('')
        try {
          await api(path, { method: 'POST', body })
          await reload()
        } catch (error) {
          setNotice(error.message)
        } finally {
          setBusy('')
        }
      }

      return h('section', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, 'TRAE'),
          h(RegionSelect, { value: region, onChange: setRegion, regions }),
        ),
        h('p', { style: S.hint },
          '点「生成登录链接」后浏览器会打开 TRAE 授权页。登录成功后页面会跳到 127.0.0.1 并显示打不开，这是正常的；把地址栏里的完整地址复制回下面即可。',
        ),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.primary, disabled: busy !== '', onClick: start },
            busy === 'trae-url' ? '生成中…' : '生成登录链接'),
        ),
        login !== null ? h('div', { style: { display: 'grid', gap: '8px' } },
          h('p', { style: S.hint }, '浏览器没有自动打开时，手动复制这个地址：'),
          h('p', { style: { ...S.notice, ...S.mono } }, login.url),
          h('textarea', {
            style: { ...S.input, minHeight: '64px', resize: 'vertical' },
            value: callbackUrl,
            placeholder: '粘贴登录后跳转的完整地址（含 refreshToken / userInfo）',
            spellCheck: false,
            onChange: event => setCallbackUrl(event.target.value),
          }),
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.primary, disabled: busy !== '', onClick: finish },
              busy === 'trae-login' ? '登录中…' : '完成登录'),
            h('button', { type: 'button', style: S.ghost, disabled: busy !== '', onClick: () => { setLogin(null); setCallbackUrl('') } }, '取消'),
          ),
        ) : null,
        h('div', { style: S.divider }),
        h(Stats, { provider: 'trae', accounts, credits, checkin }),
        h(AccountRows, {
          provider: 'trae', rows: accounts, activeId, credits, creditsLoading, checkin, busy,
          onSelect: (provider, id) => act('/accounts/active', { provider, id }),
          onRemove: (provider, id) => act('/accounts/remove', { provider, id }),
          onRefresh: (provider, id) => act('/accounts/refresh', { provider, id }),
        }),
        h('div', { style: S.divider }),
        h(CheckinControls, { provider: 'trae', summary, busy, setBusy, setNotice, reload }),
      )
    }

    function QoderCard({ summary, credits, creditsLoading, busy, setBusy, setNotice, reload }) {
      const regions = summary?.providers?.qoder?.regions ?? [{ id: 'cn', label: 'Qoder 中国版（qoder.cn）' }]
      const [region, setRegion] = useState(regions[0]?.id ?? 'cn')
      const [pat, setPat] = useState('')
      const [device, setDevice] = useState(null)
      const accounts = summary?.accounts?.qoder ?? []
      const activeId = summary?.accounts?.active?.qoder ?? ''
      const checkin = summary?.checkin?.qoder ?? {}

      useEffect(() => {
        if (device === null) return undefined
        let stopped = false
        let timer = null
        const tick = async () => {
          if (stopped) return
          try {
            const value = await api(`/qoder/login/poll?id=${encodeURIComponent(device.sessionId)}`)
            if (stopped) return
            if (value.pending !== true) {
              setDevice(null)
              setNotice(`已接入 ${value.account?.name ?? 'Qoder'}。`)
              await reload()
              return
            }
            if (Date.now() - device.startedAt > DEVICE_TTL_MS) {
              setDevice(null)
              setNotice('Qoder 授权超时，请重新发起。')
              return
            }
            timer = setTimeout(tick, POLL_MS)
          } catch (error) {
            if (stopped) return
            setDevice(null)
            setNotice(`Qoder 授权失败：${error.message}`)
          }
        }
        timer = setTimeout(tick, 1200)
        return () => { stopped = true; if (timer !== null) clearTimeout(timer) }
      }, [device, reload, setNotice])

      const addPat = async () => {
        if (pat.trim() === '') { setNotice('请粘贴 Qoder PAT（pt- 开头）'); return }
        setBusy('qoder-pat'); setNotice('')
        try {
          const value = await api('/qoder/login/pat', { method: 'POST', body: { region, pat: pat.trim() } })
          setPat('')
          setNotice(`已接入 ${value.account?.name ?? 'Qoder'}。`)
          await reload()
        } catch (error) {
          setNotice(`Qoder PAT 登录失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const startDevice = async () => {
        setBusy('qoder-device'); setNotice('')
        try {
          const value = await api('/qoder/login/url', { method: 'POST', body: { region } })
          setDevice({ sessionId: value.sessionId, url: value.url, startedAt: Date.now() })
          try { window.open(value.url, '_blank', 'noopener,noreferrer') } catch { /* 地址已经显示在下面 */ }
        } catch (error) {
          setNotice(`发起 Qoder 授权失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      const act = async (path, body) => {
        setBusy('qoder-act'); setNotice('')
        try {
          await api(path, { method: 'POST', body })
          await reload()
        } catch (error) {
          setNotice(error.message)
        } finally {
          setBusy('')
        }
      }

      return h('section', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, 'Qoder'),
          h(RegionSelect, { value: region, onChange: setRegion, regions }),
        ),
        h('p', { style: S.hint },
          '推荐用 PAT：在 qoder.com/account/integrations（国内 qoder.cn）生成 pt- 开头的令牌后粘贴到下面。也可以走浏览器授权。',
        ),
        h('div', { style: S.row },
          h('input', {
            style: S.input, value: pat, spellCheck: false, autoComplete: 'off',
            placeholder: '粘贴 pt- 开头的 PAT',
            onChange: event => setPat(event.target.value),
          }),
          h('button', { type: 'button', style: S.primary, disabled: busy !== '', onClick: addPat },
            busy === 'qoder-pat' ? '登录中…' : '添加 PAT'),
        ),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.button, disabled: busy !== '' || device !== null, onClick: startDevice },
            device !== null ? '等待浏览器确认…' : '浏览器授权'),
          device !== null ? h('button', { type: 'button', style: S.ghost, onClick: () => setDevice(null) }, '取消') : null,
        ),
        device !== null ? h('div', { style: { display: 'grid', gap: '8px' } },
          h('p', { style: S.hint }, '在打开的页面里确认授权。浏览器没打开时手动访问：'),
          h('p', { style: { ...S.notice, ...S.mono } }, device.url),
        ) : null,
        h('div', { style: S.divider }),
        h(Stats, { provider: 'qoder', accounts, credits, checkin }),
        h(AccountRows, {
          provider: 'qoder', rows: accounts, activeId, credits, creditsLoading, checkin, busy,
          onSelect: (provider, id) => act('/accounts/active', { provider, id }),
          onRemove: (provider, id) => act('/accounts/remove', { provider, id }),
          onRefresh: (provider, id) => act('/accounts/refresh', { provider, id }),
        }),
        h('div', { style: S.divider }),
        h(CheckinControls, { provider: 'qoder', summary, busy, setBusy, setNotice, reload }),
      )
    }

    function SettingsPage() {
      const [summary, setSummary] = useState(null)
      const [credits, setCredits] = useState(null)
      const [creditsLoading, setCreditsLoading] = useState(false)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [loadError, setLoadError] = useState('')

      const reload = useCallback(async () => {
        try {
          setSummary(await api('/summary'))
          setLoadError('')
        } catch (error) {
          setLoadError(error.message)
          return
        }
        // 积分要打上游，可能慢；先让账号信息渲染出来，积分随后补上。
        setCreditsLoading(true)
        try {
          const next = await api('/credits').catch(() => null)
          if (next !== null) setCredits(next)
        } finally {
          setCreditsLoading(false)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('div', {},
            h('h2', { style: { ...S.title, fontSize: '16px' } }, 'TRAE / Qoder 登录'),
            h('p', { style: S.hint }, '只维护这两条渠道的账号。账号与 token 保存在本机 ~/.dsh/trae-qoder/accounts.json（0600）。'),
          ),
          h('button', { type: 'button', style: S.ghost, onClick: () => { void reload() } }, '刷新'),
        ),
        loadError !== '' ? h('p', { style: { ...S.notice, ...S.error } }, `读取账号失败：${loadError}`) : null,
        notice !== '' ? h('p', { style: S.notice }, notice) : null,
        h('div', { style: S.grid },
          h(TraeCard, { summary, credits, creditsLoading, busy, setBusy, setNotice, reload }),
          h(QoderCard, { summary, credits, creditsLoading, busy, setBusy, setNotice, reload }),
        ),
        h('p', { style: S.subtle },
          '登录后，TRAE / Qoder 的模型会出现在模型选择器里；Qoder 带官方倍率，TRAE 仅有官方公布积分消耗速度的模型会带倍率。上游协议随时可能变化；不要把主账号用在这里。',
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'trae-qoder',
        order: 36,
        label: () => 'TRAE / Qoder',
        locale: NS,
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'trae-qoder'
    return module.exports
  },
})

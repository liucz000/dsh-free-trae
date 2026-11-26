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
      name: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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

    function AccountRows({ provider, rows, activeId, onSelect, onRemove, onRefresh, busy }) {
      if (rows.length === 0) return h('p', { style: S.hint }, '还没有账号。')
      return h('div', { style: { display: 'grid', gap: '8px' } },
        rows.map(row => h('div', { key: row.id, style: S.account },
          h('div', { style: S.accountText },
            h('div', { style: S.name }, row.name || row.uid),
            h('div', { style: S.subtle },
              row.region === 'cn' ? '国内' : (row.region === 'global' ? '国际' : row.region),
              row.uid ? ` · ${row.uid}` : '',
              row.refreshable ? '' : ' · 不可续期',
            ),
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
        )),
      )
    }

    function TraeCard({ summary, busy, setBusy, setNotice, reload }) {
      const regions = summary?.providers?.trae?.regions ?? [{ id: 'cn', label: 'TRAE 国服（trae.cn）' }]
      const [region, setRegion] = useState(regions[0]?.id ?? 'cn')
      const [login, setLogin] = useState(null)
      const [callbackUrl, setCallbackUrl] = useState('')
      const accounts = summary?.accounts?.trae ?? []
      const activeId = summary?.accounts?.active?.trae ?? ''

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
        h('div', { style: { height: '1px', background: 'var(--dsw-alias-border-l2, #e7e7ee)' } }),
        h(AccountRows, {
          provider: 'trae', rows: accounts, activeId, busy,
          onSelect: (provider, id) => act('/accounts/active', { provider, id }),
          onRemove: (provider, id) => act('/accounts/remove', { provider, id }),
          onRefresh: (provider, id) => act('/accounts/refresh', { provider, id }),
        }),
      )
    }

    function QoderCard({ summary, busy, setBusy, setNotice, reload }) {
      const regions = summary?.providers?.qoder?.regions ?? [{ id: 'cn', label: 'Qoder 中国版（qoder.cn）' }]
      const [region, setRegion] = useState(regions[0]?.id ?? 'cn')
      const [pat, setPat] = useState('')
      const [device, setDevice] = useState(null)
      const accounts = summary?.accounts?.qoder ?? []
      const activeId = summary?.accounts?.active?.qoder ?? ''

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
        h('div', { style: { height: '1px', background: 'var(--dsw-alias-border-l2, #e7e7ee)' } }),
        h(AccountRows, {
          provider: 'qoder', rows: accounts, activeId, busy,
          onSelect: (provider, id) => act('/accounts/active', { provider, id }),
          onRemove: (provider, id) => act('/accounts/remove', { provider, id }),
          onRefresh: (provider, id) => act('/accounts/refresh', { provider, id }),
        }),
      )
    }

    function SettingsPage() {
      const [summary, setSummary] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [loadError, setLoadError] = useState('')

      const reload = useCallback(async () => {
        try {
          setSummary(await api('/summary'))
          setLoadError('')
        } catch (error) {
          setLoadError(error.message)
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
          h(TraeCard, { summary, busy, setBusy, setNotice, reload }),
          h(QoderCard, { summary, busy, setBusy, setNotice, reload }),
        ),
        h('p', { style: S.subtle },
          '登录后，TRAE / Qoder 的模型会出现在模型选择器里。上游协议随时可能变化；不要把主账号用在这里。',
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

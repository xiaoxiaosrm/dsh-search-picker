/**
 * Browser half of `dsh-search-picker`.
 *
 * Registers one seat in the sidebar footer (`sidebar.footer.action`, above the
 * Settings row) that shows the currently selected `web.searchProvider` and
 * opens a menu listing every selectable search API.
 *
 * Switching writes the `web` settings namespace through the official client
 * services (`ctx.configForms` + `ctx.remote.credentials`), the same field the
 * built-in Plugins > Web search page edits. The host seam reads the value on
 * every search, so a switch takes effect immediately with no restart.
 *
 * The bundle is hand-written against `window.__ModuleLoader__.load` (the
 * desktop and web client kernel both provide it), so no build step is needed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-search-picker',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const react = require('react')
    const h = react.createElement

    /** Locale namespace and bridge-independent identity of the plugin. */
    const NS = 'dsh-search-picker'

    /**
     * Selectable engines. `ref` is the credential reference the provider
     * resolves; the picker greys an engine out when the host reports it
     * unconfigured. The two official DeepSeek entries are served by the
     * built-in packages; the other three are served by this plugin's host half.
     */
    const ENGINES = [
      { id: 'deepseek-official', label: 'DeepSeek 官方 Messages', short: 'DeepSeek Messages', ref: 'DEEPSEEK_API_KEY', badge: 'official' },
      { id: 'deepseek-search-api', label: 'DeepSeek 官方 Search API', short: 'DeepSeek Search API', ref: 'DEEPSEEK_API_KEY', badge: 'official' },
      { id: 'opencode-go', label: 'OpenCode Go', short: 'OpenCode Go', ref: 'OPENCODE_GO_API_KEY', badge: 'go' },
      { id: 'tavily', label: 'Tavily', short: 'Tavily', ref: 'TAVILY_API_KEY', badge: 'key' },
      { id: 'exa', label: 'Exa', short: 'Exa', ref: 'EXA_API_KEY', badge: 'key' },
    ]

    /** Engine shown when the namespace has no explicit selection yet. */
    const DEFAULT_ENGINE_ID = 'deepseek-official'

    /** Menu width in the 56px rail, where the column is too narrow to fit one. */
    const RAIL_MENU_WIDTH = 280

    /** CSS (sidebar footer seat + upward menu). */
    const CSS = [
      '.dspk-root{min-width:0;position:relative}',
      '.dspk-wide{width:100%}',
      '.dspk-rail{width:auto}',
      '.dspk-trigger{min-width:0;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:6px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}',
      '.dspk-wide .dspk-trigger{width:100%}',
      '.dspk-rail .dspk-trigger{width:36px;height:36px;justify-content:center;padding:0}',
      '.dspk-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dspk-trigger:disabled{opacity:.6;cursor:default}',
      '.dspk-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto;overflow:hidden}',
      '.dspk-icon{flex:none;color:var(--dsw-alias-label-caption)}',
      '.dspk-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}',
      '.dspk-chevronOpen{transform:rotate(180deg)}',
      '.dspk-menu{z-index:30;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel,0 0 0 .5px var(--dsw-alias-border-l4),0 3px 8px rgba(0,0,0,.06),0 0 16px rgba(0,0,0,.04));--dsw-elevation-stroke-color:var(--dsw-alias-border-l4);max-width:calc(100vw - 16px);max-height:min(420px,100vh - 96px);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:fixed;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}',
      '.dspk-status{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}',
      '.dspk-error{color:var(--dsw-alias-state-error-primary);padding:8px 10px;font-size:12px;line-height:18px}',
      '.dspk-groupTitle{color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px}',
      '.dspk-option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}',
      '.dspk-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dspk-option:disabled{opacity:.55;cursor:default}',
      '.dspk-optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}',
      '.dspk-optionLabel{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}',
      '.dspk-optionBadge{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}',
      '.dspk-check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}',
    ].join('')

    if (typeof document !== 'undefined') {
      const tagId = `${NS}/client.css`
      const selector = `style[data-plugin-css=${JSON.stringify(tagId)}]`
      const existing = document.querySelector(selector)
      if (existing !== null) {
        existing.textContent = CSS
      } else {
        const tag = document.createElement('style')
        tag.dataset.plugin = NS
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    /** Find the engine entry for an id (unknown ids fall back to a readable label). */
    function engineOf(id) {
      return ENGINES.find((engine) => engine.id === id)
    }

    /** Short label for the trigger. */
    function shortLabelOf(id) {
      const engine = engineOf(id)
      return engine === undefined ? id : engine.short
    }

    /** Check icon (React element). */
    function checkIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true,
      }, h('path', {
        d: 'M3 8.5L6.5 12 13 4.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /** Search icon (React element). */
    function searchIcon(key) {
      return h('svg', {
        key,
        viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true, className: 'dspk-icon',
      }, [
        h('circle', { key: 'c', cx: 7, cy: 7, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { key: 'l', d: 'M10.2 10.2L14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      ])
    }

    /** Chevron icon (React element). */
    function chevron(open) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
        className: open ? 'dspk-chevron dspk-chevronOpen' : 'dspk-chevron',
      }, h('path', {
        d: 'M4 6l4 4 4-4',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * Build the picker component closed over the plugin context.
     * @param {object} ctx - client plugin context (configForms / remote available).
     * @param {(key: string) => string} t - locale lookup.
     * @returns {Function} React component for the `sidebar.footer.action` slot.
     */
    function createPicker(ctx, t) {
      const form = ctx.configForms.get('web')

      return function SearchPicker(props) {
        const wide = props !== null && typeof props === 'object' && props.wide === false ? false : true
        const [snapshot, setSnapshot] = react.useState(() => form.getSnapshot())
        const [open, setOpen] = react.useState(false)
        const [credentials, setCredentials] = react.useState({})
        const [busy, setBusy] = react.useState(false)
        const [error, setError] = react.useState(null)
        const [anchor, setAnchor] = react.useState(null)
        const rootRef = react.useRef(null)
        const triggerRef = react.useRef(null)
        const menuRef = react.useRef(null)
        const id = react.useId()

        const currentId = (() => {
          const value = snapshot?.value?.searchProvider
          if (typeof value === 'string' && value.length > 0) return value
          const base = snapshot?.base?.searchProvider
          if (typeof base === 'string' && base.length > 0) return base
          return DEFAULT_ENGINE_ID
        })()

        react.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [])

        /**
         * Anchor the fixed-position menu to the trigger.
         *
         * The sidebar column clips overflow (AppFrame's `.sidebarCol` is
         * `overflow: hidden`), so an absolutely positioned menu wider than the
         * column is cut off. The menu therefore renders `position: fixed` and
         * takes its geometry from the trigger's box: in wide mode it spans the
         * sidebar's content width (which follows a sidebar drag), while the
         * 56px rail opens a readable width to the right of the icon.
         */
        react.useLayoutEffect(() => {
          if (!open) {
            setAnchor(null)
            return undefined
          }
          const place = () => {
            const root = rootRef.current
            if (!root) return
            const rect = root.getBoundingClientRect()
            const viewportWidth = window.innerWidth
            const width = wide
              ? rect.width
              : Math.min(RAIL_MENU_WIDTH, viewportWidth - rect.left - 8)
            setAnchor({
              left: Math.max(8, Math.min(rect.left, viewportWidth - width - 8)),
              bottom: Math.max(8, window.innerHeight - rect.top + 8),
              width,
            })
          }
          place()
          const root = rootRef.current
          const observer = typeof ResizeObserver === 'function' && root !== null
            ? new ResizeObserver(place)
            : null
          observer?.observe(root)
          window.addEventListener('resize', place)
          return () => {
            observer?.disconnect()
            window.removeEventListener('resize', place)
          }
        }, [open, wide])

        /** Re-read whether each engine's credential reference is configured. */
        const refreshCredentials = react.useCallback(async () => {
          const refs = [...new Set(ENGINES.map((engine) => engine.ref))]
          try {
            const response = await ctx.remote.credentials.describe(refs)
            if (response?.ok === true && response.value !== null && typeof response.value === 'object') {
              setCredentials(response.value)
            }
          } catch {
            // The menu still works; only the grey-out hints are unavailable.
          }
        }, [])

        react.useEffect(() => {
          void refreshCredentials()
        }, [refreshCredentials])

        react.useEffect(() => {
          if (!open) return undefined
          void refreshCredentials()
          const closeOutside = (event) => {
            if (rootRef.current?.contains(event.target)) return
            setOpen(false)
          }
          document.addEventListener('mousedown', closeOutside)
          return () => document.removeEventListener('mousedown', closeOutside)
        }, [open, refreshCredentials])

        const menuReady = anchor !== null

        react.useEffect(() => {
          if (!open || !menuReady) return
          const menu = menuRef.current
          if (!menu) return
          const option = menu.querySelector(`[data-engine=${JSON.stringify(currentId)}]`)
            ?? menu.querySelector('[role="menuitemradio"]')
          option?.focus()
        }, [open, currentId, menuReady])

        const close = (restoreFocus) => {
          setOpen(false)
          if (restoreFocus === true) {
            queueMicrotask(() => triggerRef.current?.focus())
          }
        }

        const choose = async (engineId) => {
          if (engineId === currentId) {
            close(true)
            return
          }
          setBusy(true)
          setError(null)
          try {
            const accepted = await form.set('searchProvider', engineId)
            if (accepted !== true) {
              setError(t('error.write'))
              return
            }
            setSnapshot(form.getSnapshot())
            close(true)
          } catch (caught) {
            setError(String(caught))
          } finally {
            setBusy(false)
          }
        }

        const onRootKeyDown = (event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            close(true)
          }
        }

        const onMenuKeyDown = (event) => {
          const menu = menuRef.current
          if (!menu || busy) return
          const options = Array.from(menu.querySelectorAll('[role="menuitemradio"]:not(:disabled)'))
          if (options.length === 0) return
          const index = options.indexOf(document.activeElement)
          const moveTo = (target) => {
            event.preventDefault()
            options[target]?.focus()
          }
          switch (event.key) {
            case 'ArrowDown':
              moveTo(index === -1 ? 0 : (index + 1) % options.length)
              break
            case 'ArrowUp':
              moveTo(index === -1 ? options.length - 1 : (index - 1 + options.length) % options.length)
              break
            case 'Home':
              moveTo(0)
              break
            case 'End':
              moveTo(options.length - 1)
              break
            default:
              break
          }
        }

        const label = shortLabelOf(currentId)
        const triggerText = `${t('trigger.label')}${wide ? label : ''}`
        const triggerChildren = wide
          ? [
            searchIcon('search'),
            h('span', { key: 'label', className: 'dspk-triggerLabel' }, triggerText),
            chevron(open),
          ]
          : [searchIcon('search'), chevron(open)]

        const menuItems = []
        menuItems.push(h('div', { key: 'title', className: 'dspk-groupTitle' }, t('menu.title')))
        for (const engine of ENGINES) {
          const credential = credentials[engine.ref]
          const configured = credential === undefined ? undefined : credential.configured === true
          const disabled = busy || configured === false
          const selected = engine.id === currentId
          menuItems.push(h('button', {
            key: engine.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            className: 'dspk-option',
            'data-engine': engine.id,
            title: disabled && configured === false ? `${t('menu.notConfigured')}${engine.ref}` : engine.label,
            disabled,
            onClick: () => { void choose(engine.id) },
          }, [
            h('span', { key: 'copy', className: 'dspk-optionCopy' }, [
              h('span', { key: 'label', className: 'dspk-optionLabel' }, engine.label),
              h('span', { key: 'badge', className: 'dspk-optionBadge' }, configured === false
                ? `${t('menu.notConfigured')}${engine.ref}`
                : (engine.badge === 'official' ? t('badge.official') : t('badge.custom'))),
            ]),
            selected ? h('span', { key: 'check', className: 'dspk-check' }, checkIcon()) : null,
          ]))
        }
        if (snapshot?.status !== undefined && snapshot.status !== 'ready') {
          menuItems.push(h('div', { key: 'status', className: 'dspk-status' }, t('menu.loading')))
        }

        return h('div', {
          ref: rootRef,
          className: wide ? 'dspk-root dspk-wide' : 'dspk-root dspk-rail',
          onKeyDown: onRootKeyDown,
        }, [
          h('button', {
            key: 'trigger',
            ref: triggerRef,
            type: 'button',
            className: 'dspk-trigger',
            'aria-label': `${t('trigger.aria')}${label}`,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-controls': open ? `${id}-menu` : undefined,
            title: `${t('trigger.aria')}${label}`,
            onClick: () => { if (open) close(false); else setOpen(true) },
            onKeyDown: (event) => {
              if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
                event.preventDefault()
                setOpen(true)
              }
            },
          }, triggerChildren),
          open && anchor !== null ? h('div', {
            key: 'menu',
            id: `${id}-menu`,
            ref: menuRef,
            className: 'dspk-menu',
            role: 'menu',
            'aria-label': t('menu.aria'),
            'aria-busy': busy,
            style: {
              left: `${anchor.left}px`,
              bottom: `${anchor.bottom}px`,
              width: `${anchor.width}px`,
            },
            onKeyDown: onMenuKeyDown,
          }, [
            busy ? h('div', { key: 'busy', className: 'dspk-status' }, t('menu.switching')) : null,
            error !== null ? h('div', { key: 'error', className: 'dspk-error' }, error) : null,
            ...(busy ? [] : menuItems),
          ]) : null,
        ])
      }
    }

    /** Client plugin manifest: the seats this bundle fills. */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

    /**
     * Register the sidebar picker.
     * @param {object} ctx - client plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          'trigger.label': '搜索：',
          'trigger.aria': '搜索引擎：',
          'menu.title': '选择搜索 API',
          'menu.aria': '搜索 API',
          'menu.loading': '正在读取搜索设置…',
          'menu.switching': '正在切换…',
          'menu.notConfigured': '未配置 ',
          'badge.official': '官方',
          'badge.custom': '本插件提供',
          'error.write': '切换失败：设置被宿主拒绝，请重试',
        },
        en: {
          'trigger.label': 'Search: ',
          'trigger.aria': 'Search API: ',
          'menu.title': 'Choose search API',
          'menu.aria': 'Search API',
          'menu.loading': 'Reading search settings…',
          'menu.switching': 'Switching…',
          'menu.notConfigured': 'Not configured: ',
          'badge.official': 'Built-in',
          'badge.custom': 'This plugin',
          'error.write': 'Switch failed: the host rejected the settings write',
        },
      }), 'dsh-search-picker: dictionaries')

      const t = ctx.locale.bind(NS)
      const Picker = createPicker(ctx, t)

      ctx.inject(['slots'], (scope) => {
        scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
          name: 'sidebar.footer.action',
          id: 'search-picker',
          locale: NS,
          order: 10,
          inject: () => ({}),
        }, Picker))
      })
    }

    exports.name = NS
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})

/**
 * Host half of `dsh-search-picker`.
 *
 * Registers three custom search providers into the `ctx.web` seam:
 *   - `opencode-go`  OpenCode Go's Anthropic-compatible Messages endpoint with
 *                    the native `web_search_20250305` server tool
 *   - `tavily`       Tavily `/search`
 *   - `exa`          Exa `/search`
 *
 * The built-in `deepseek-official` (Messages) and `deepseek-search-api`
 * (Search API) providers are NOT registered here: the official packages own
 * them, and the sidebar picker simply writes `web.searchProvider` (the same
 * field the official Plugins > Web search page edits). This plugin never takes
 * that field over on startup.
 *
 * The module imports nothing from `@deepseek-ai/*`. The desktop runtime's
 * loader owns module resolution for plugin packages; the only interfaces used
 * here are the injected `web`, `credentials`, and `agents` services plus the
 * global `fetch`.
 */

import { randomUUID } from 'node:crypto'
import {
  searchOpencodeGo,
  searchTavily,
  searchExa,
  EngineError,
} from './engines.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'search-picker'

/** The capability seam this plugin registers providers into. */
export const inject = ['web']

/** Default provider configuration; every key can be overridden in the entry config. */
export const DEFAULT_ENGINE_OPTIONS = Object.freeze({
  opencodeGo: Object.freeze({
    baseURL: 'https://opencode.ai/inference/go/anthropic/v1',
    model: 'deepseek-v4.1-flash',
    maxTokens: 4096,
    maxUses: 5,
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
  }),
  tavily: Object.freeze({
    baseURL: 'https://api.tavily.com',
    apiKeyEnv: 'TAVILY_API_KEY',
  }),
  exa: Object.freeze({
    baseURL: 'https://api.exa.ai',
    apiKeyEnv: 'EXA_API_KEY',
  }),
})

/** True for a positive integer. */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/** Merge one engine's entry config over its defaults. */
function resolveEngineConfig(defaults, overrides) {
  if (overrides === null || typeof overrides !== 'object') return { ...defaults }
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/**
 * Register the custom providers with `ctx.web`.
 *
 * @param {object} ctx - Cordis context with `web` injected.
 * @param {object} [config] - entry config (`opencodeGo`, `tavily`, `exa`).
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const entry = config !== null && typeof config === 'object' ? config : {}
  const opencodeGo = resolveEngineConfig(DEFAULT_ENGINE_OPTIONS.opencodeGo, entry.opencodeGo)
  const tavily = resolveEngineConfig(DEFAULT_ENGINE_OPTIONS.tavily, entry.tavily)
  const exa = resolveEngineConfig(DEFAULT_ENGINE_OPTIONS.exa, entry.exa)

  // One stable opaque session value for the whole process: the Go relay pins
  // requests that share it to the same upstream backend, but it must only be
  // opaque and stable, never the DSH conversation identity.
  const fallbackSessionId = randomUUID()

  /**
   * Resolve one credential reference through the credentials plane, falling
   * back to the launching environment when that service is absent.
   * @param {string} ref - credential reference (environment-style name).
   * @returns {Promise<string|undefined>} the resolved non-empty value.
   */
  async function resolveKey(ref) {
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(ref)
        if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value
      } catch {
        // Fall through to the ambient environment; a missing credential is
        // reported by the adapter as WEB_PROVIDER_CREDENTIAL_MISSING.
      }
    }
    const ambient = process.env[ref]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /**
   * The DSH session id for the request that triggered this search, when one is
   * reachable. The Go endpoint only needs an opaque stable value, so a process
   * UUID is a valid fallback.
   * @returns {string|undefined} the session header value.
   */
  function currentSessionId() {
    try {
      const session = ctx.get('agents')?.currentInitiator()?.session
      const id = session?.id
      if (typeof id === 'string' && id.length > 0) return id
    } catch {
      // No agent plane at this point (auxiliary call); use the fallback.
    }
    return fallbackSessionId
  }

  /** Build one provider entry whose `search` runs a single engine adapter. */
  function createProvider(id, label, available, run) {
    return {
      id,
      available,
      async search(request, signal) {
        const query = typeof request?.query === 'string' ? request.query : ''
        const maxResults = isPositiveInteger(request?.maxResults) ? request.maxResults : undefined
        try {
          return await run({ query, maxResults, signal })
        } catch (error) {
          if (error instanceof EngineError) throw error
          throw new EngineError(`${label} search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
        }
      },
    }
  }

  const opencodeGoProvider = createProvider(
    'opencode-go',
    'OpenCode Go',
    () => URL.canParse(opencodeGo.baseURL)
      && typeof opencodeGo.model === 'string' && opencodeGo.model.length > 0
      && isPositiveInteger(opencodeGo.maxTokens)
      && isPositiveInteger(opencodeGo.maxUses),
    async ({ query, signal }) => {
      const apiKey = await resolveKey(opencodeGo.apiKeyEnv)
      if (apiKey === undefined) {
        throw new EngineError(
          `OpenCode Go search has no API key for "${opencodeGo.apiKeyEnv}"; store it in the credentials service or the launching environment`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      return searchOpencodeGo({
        baseURL: opencodeGo.baseURL,
        model: opencodeGo.model,
        maxTokens: opencodeGo.maxTokens,
        maxUses: opencodeGo.maxUses,
        apiKey,
        sessionId: currentSessionId(),
        query,
        signal,
        engineLabel: 'OpenCode Go search',
      })
    },
  )

  const tavilyProvider = createProvider(
    'tavily',
    'Tavily',
    () => URL.canParse(tavily.baseURL)
      && typeof tavily.apiKeyEnv === 'string' && tavily.apiKeyEnv.length > 0,
    async ({ query, maxResults, signal }) => {
      const apiKey = await resolveKey(tavily.apiKeyEnv)
      if (apiKey === undefined) {
        throw new EngineError(
          `Tavily search has no API key for "${tavily.apiKeyEnv}"; store it in the credentials service or the launching environment`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      return searchTavily({ baseURL: tavily.baseURL, apiKey, query, maxResults, signal })
    },
  )

  const exaProvider = createProvider(
    'exa',
    'Exa',
    () => URL.canParse(exa.baseURL)
      && typeof exa.apiKeyEnv === 'string' && exa.apiKeyEnv.length > 0,
    async ({ query, maxResults, signal }) => {
      const apiKey = await resolveKey(exa.apiKeyEnv)
      if (apiKey === undefined) {
        throw new EngineError(
          `Exa search has no API key for "${exa.apiKeyEnv}"; store it in the credentials service or the launching environment`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      return searchExa({ baseURL: exa.baseURL, apiKey, query, maxResults, signal })
    },
  )

  ctx.effect(() => {
    const disposers = [
      ctx.web.registerSearchProvider(opencodeGoProvider),
      ctx.web.registerSearchProvider(tavilyProvider),
      ctx.web.registerSearchProvider(exaProvider),
    ]
    ctx.logger?.info?.(
      'search-picker: registered providers opencode-go / tavily / exa (tavily and exa need TAVILY_API_KEY / EXA_API_KEY)',
    )
    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* already disposed with the seam */ }
      }
    }
  }, 'search-picker: web providers')
}

export default { name, inject, apply }

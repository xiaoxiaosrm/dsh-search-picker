/**
 * Search-engine adapters for the `dsh-search-picker` host plugin.
 *
 * Every adapter takes already-resolved options plus a query and returns the
 * `ctx.web` result shape `{ sources, truncated: false }`. Error codes follow
 * the `dsh-web` vocabulary so `web_search` surfaces the same taxonomy for
 * built-in and custom providers:
 *   - WEB_PROVIDER_CREDENTIAL_MISSING: no API key could be resolved
 *   - WEB_ABORTED: the caller cancelled the search
 *   - WEB_PROVIDER_ERROR: transport, HTTP, or response-shape failure
 *
 * This module deliberately imports nothing from `@deepseek-ai/*`: the plugin
 * runs inside the desktop runtime whose module resolution is owned by the
 * loader, and a plain Error carrying `code` is what `dsh-tool-web` renders.
 */

/** Machine-routable error used by every adapter. */
export class EngineError extends Error {
  /**
   * @param {string} message - engine-labelled human-readable failure.
   * @param {string} code - `dsh-web` error code.
   * @param {{ cause?: unknown }} [options] - optional cause chain.
   */
  constructor(message, code = 'WEB_PROVIDER_ERROR', options = {}) {
    super(message, options)
    this.name = 'EngineError'
    this.code = code
  }
}

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-search-picker/0.1.0'

/** Default Anthropic protocol version for Messages-API search. */
export const ANTHROPIC_VERSION = '2023-06-01'

/** True for an aborted fetch / signal. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Throw the stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortedError(signal)
}

/** Build the stable cancellation error while retaining the caller's reason. */
function abortedError(signal, fallback) {
  return new EngineError('search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** Race one async preflight against caller cancellation. */
function abortable(operation, signal) {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(abortedError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => { reject(abortedError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Read a useful message out of a failed HTTP response without throwing. */
async function httpErrorMessage(response, signal) {
  let detail
  try {
    const text = await response.text()
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text)
        detail = typeof parsed?.error === 'string'
          ? parsed.error
          : parsed?.error?.message ?? parsed?.message
        if (typeof detail !== 'string' || detail.length === 0) {
          detail = text.slice(0, 300)
        }
      } catch {
        detail = text.slice(0, 300)
      }
    }
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
  }
  return detail
}

/** Trim a string field; returns undefined for absent/blank values. */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Map an Anthropic-compatible Messages response carrying one or more
 * `web_search_tool_result` blocks into normalized sources.
 *
 * Sources carry `url` plus optional `title` / `snippet` / `publishedAt`.
 * `snippet` comes from `text` blocks' `citations[].cited_text` keyed by URL
 * (first occurrence wins); duplicates by URL are dropped.
 *
 * @param {unknown} payload - parsed Messages response body.
 * @param {string} [engineLabel] - label used in the failure message.
 * @returns {{ sources: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, truncated: false }}
 * @throws {EngineError} when no `web_search_tool_result` block is present.
 */
export function mapAnthropicResponse(payload, engineLabel = 'Anthropic search') {
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new EngineError(
      `${engineLabel} returned no web_search_tool_result blocks; the request may not have triggered native web search`,
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    for (const citation of block.citations ?? []) {
      const url = nonEmpty(citation?.url)
      const cited = nonEmpty(citation?.cited_text)
      if (url !== undefined && cited !== undefined && !snippets.has(url)) snippets.set(url, cited)
    }
  }

  const seen = new Set()
  const sources = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result') continue
      const url = nonEmpty(item.url)
      if (url === undefined || seen.has(url)) continue
      seen.add(url)
      const title = nonEmpty(item.title)
      const publishedAt = nonEmpty(item.page_age)
      const snippet = snippets.get(url)
      sources.push({
        url,
        ...(title !== undefined ? { title } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      })
    }
  }
  return { sources, truncated: false }
}

/**
 * Run one search through an Anthropic-compatible Messages endpoint with the
 * native `web_search_20250305` server tool (used by OpenCode Go).
 *
 * @param {object} options - resolved adapter options.
 * @param {string} options.baseURL - endpoint base; `/messages` is appended.
 * @param {string} options.model - Anthropic-format model name.
 * @param {number} options.maxTokens - upper bound on generated tokens.
 * @param {number} options.maxUses - maximum server-tool uses per request.
 * @param {string} options.apiKey - resolved API key.
 * @param {string} [options.sessionId] - value for `x-opencode-session`.
 * @param {string} options.query - search query.
 * @param {AbortSignal} [options.signal] - cancellation signal.
 * @param {string} [options.engineLabel] - label used in error messages.
 * @returns {Promise<{ sources: Array<object>, truncated: false }>}
 */
export async function searchOpencodeGo(options) {
  const {
    baseURL,
    model,
    maxTokens,
    maxUses,
    apiKey,
    sessionId,
    query,
    signal,
    engineLabel = 'OpenCode Go search',
  } = options
  throwIfAborted(signal)
  const endpoint = `${baseURL}/messages`
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
  }
  const headers = {
    'x-api-key': apiKey,
    authorization: `Bearer ${apiKey}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...(sessionId !== undefined && sessionId.length > 0 ? { 'x-opencode-session': sessionId } : {}),
  }

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new EngineError(`${engineLabel} request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (!response.ok) {
    const detail = await httpErrorMessage(response, signal)
    throw new EngineError(
      `${engineLabel} error (HTTP ${response.status})${detail !== undefined ? `: ${detail}` : ''} (endpoint ${endpoint})`,
      'WEB_PROVIDER_ERROR',
    )
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new EngineError(`${engineLabel} returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  return mapAnthropicResponse(payload, engineLabel)
}

/**
 * Map a Tavily `/search` response into normalized sources.
 *
 * @param {unknown} payload - parsed Tavily response body.
 * @returns {{ content?: string, sources: Array<object>, truncated: false }}
 */
export function mapTavilyResponse(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  const sources = []
  for (const result of results) {
    const url = nonEmpty(result?.url)
    if (url === undefined) continue
    const title = nonEmpty(result.title)
    const snippet = nonEmpty(result.content)
    sources.push({
      url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(nonEmpty(result.published_date) !== undefined ? { publishedAt: result.published_date } : {}),
    })
  }
  const answer = nonEmpty(payload?.answer)
  return {
    ...(answer !== undefined ? { content: answer } : {}),
    sources,
    truncated: false,
  }
}

/**
 * Run one search through the Tavily `/search` API.
 *
 * @param {object} options - resolved adapter options.
 * @param {string} options.baseURL - Tavily API base (default `https://api.tavily.com`).
 * @param {string} options.apiKey - resolved Tavily API key.
 * @param {string} options.query - search query.
 * @param {number} [options.maxResults] - requested result count.
 * @param {AbortSignal} [options.signal] - cancellation signal.
 * @returns {Promise<{ content?: string, sources: Array<object>, truncated: false }>}
 */
export async function searchTavily(options) {
  const { baseURL, apiKey, query, maxResults, signal } = options
  const apiKeyResolved = await abortable(Promise.resolve(apiKey), signal)
  throwIfAborted(signal)
  if (nonEmpty(apiKeyResolved) === undefined) {
    throw new EngineError('Tavily search has no API key for "TAVILY_API_KEY"', 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
  const endpoint = `${baseURL.replace(/\/+$/u, '')}/search`
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({
        api_key: apiKeyResolved,
        query,
        max_results: Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 8,
        search_depth: 'basic',
      }),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new EngineError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (!response.ok) {
    const detail = await httpErrorMessage(response, signal)
    throw new EngineError(
      `Tavily API error (HTTP ${response.status})${detail !== undefined ? `: ${detail}` : ''} (endpoint ${endpoint})`,
      'WEB_PROVIDER_ERROR',
    )
  }
  try {
    return mapTavilyResponse(await response.json())
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new EngineError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Map an Exa `/search` response into normalized sources.
 *
 * @param {unknown} payload - parsed Exa response body.
 * @returns {{ sources: Array<object>, truncated: false }}
 */
export function mapExaResponse(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  const sources = []
  for (const result of results) {
    const url = nonEmpty(result?.url)
    if (url === undefined) continue
    const title = nonEmpty(result.title)
    const snippet = nonEmpty(result.text)
    const publishedAt = nonEmpty(result.publishedDate) ?? nonEmpty(result.published_date)
    sources.push({
      url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    })
  }
  return { sources, truncated: false }
}

/**
 * Run one search through the Exa `/search` API.
 *
 * @param {object} options - resolved adapter options.
 * @param {string} options.baseURL - Exa API base (default `https://api.exa.ai`).
 * @param {string} options.apiKey - resolved Exa API key.
 * @param {string} options.query - search query.
 * @param {number} [options.maxResults] - requested result count.
 * @param {AbortSignal} [options.signal] - cancellation signal.
 * @returns {Promise<{ sources: Array<object>, truncated: false }>}
 */
export async function searchExa(options) {
  const { baseURL, apiKey, query, maxResults, signal } = options
  const apiKeyResolved = await abortable(Promise.resolve(apiKey), signal)
  throwIfAborted(signal)
  if (nonEmpty(apiKeyResolved) === undefined) {
    throw new EngineError('Exa search has no API key for "EXA_API_KEY"', 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
  const endpoint = `${baseURL.replace(/\/+$/u, '')}/search`
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': apiKeyResolved,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        query,
        numResults: Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 8,
        contents: { text: true },
      }),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new EngineError(`Exa search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (!response.ok) {
    const detail = await httpErrorMessage(response, signal)
    throw new EngineError(
      `Exa API error (HTTP ${response.status})${detail !== undefined ? `: ${detail}` : ''} (endpoint ${endpoint})`,
      'WEB_PROVIDER_ERROR',
    )
  }
  try {
    return mapExaResponse(await response.json())
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    throw new EngineError(`Exa returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

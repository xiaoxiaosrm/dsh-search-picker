import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EngineError,
  mapAnthropicResponse,
  mapTavilyResponse,
  mapExaResponse,
  searchTavily,
  searchExa,
  searchOpencodeGo,
} from '../lib/engines.js'

/** Replace globalThis.fetch for one test and restore it afterwards. */
function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original
  })
}

test('mapAnthropicResponse joins citations and dedupes by URL', () => {
  const payload = {
    content: [
      {
        type: 'text',
        text: 'answer',
        citations: [
          { url: 'https://a.example/1', cited_text: 'snippet a' },
          { url: 'https://b.example/2', cited_text: 'snippet b' },
        ],
      },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.example/1', title: 'A', page_age: '2026-10-01' },
          { type: 'web_search_result', url: 'https://b.example/2', title: 'B' },
          { type: 'web_search_result', url: 'https://a.example/1', title: 'A duplicate' },
        ],
      },
    ],
  }
  const result = mapAnthropicResponse(payload, 'Go')
  assert.equal(result.truncated, false)
  assert.equal(result.sources.length, 2)
  assert.deepEqual(result.sources[0], {
    url: 'https://a.example/1',
    title: 'A',
    snippet: 'snippet a',
    publishedAt: '2026-10-01',
  })
  assert.deepEqual(result.sources[1], {
    url: 'https://b.example/2',
    title: 'B',
    snippet: 'snippet b',
  })
})

test('mapAnthropicResponse throws WEB_PROVIDER_ERROR without result blocks', () => {
  assert.throws(
    () => mapAnthropicResponse({ content: [{ type: 'text', text: 'no results' }] }, 'Go'),
    (error) => error instanceof EngineError && error.code === 'WEB_PROVIDER_ERROR',
  )
})

test('mapTavilyResponse maps results and optional answer', () => {
  const result = mapTavilyResponse({
    answer: 'short answer',
    results: [
      { url: 'https://c.example', title: 'C', content: 'snippet c' },
      { url: '', title: 'dropped', content: '' },
    ],
  })
  assert.equal(result.content, 'short answer')
  assert.equal(result.sources.length, 1)
  assert.deepEqual(result.sources[0], {
    url: 'https://c.example',
    title: 'C',
    snippet: 'snippet c',
  })
})

test('mapExaResponse maps results with text snippets', () => {
  const result = mapExaResponse({
    results: [
      { url: 'https://d.example', title: 'D', text: 'exa text', publishedDate: '2026-09-01' },
    ],
  })
  assert.equal(result.sources.length, 1)
  assert.deepEqual(result.sources[0], {
    url: 'https://d.example',
    title: 'D',
    snippet: 'exa text',
    publishedAt: '2026-09-01',
  })
})

test('searchTavily rejects without an API key', async () => {
  await assert.rejects(
    () => searchTavily({ baseURL: 'https://api.tavily.com', apiKey: undefined, query: 'q' }),
    (error) => error instanceof EngineError && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
})

test('searchTavily posts to /search and returns mapped sources', async () => {
  let seen
  await withFetch(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ results: [{ url: 'https://e.example', title: 'E', content: 's' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }, async () => {
    const result = await searchTavily({
      baseURL: 'https://api.tavily.com',
      apiKey: 'tvly-test',
      query: 'hello',
      maxResults: 3,
    })
    assert.equal(result.sources.length, 1)
  })
  assert.equal(seen.url, 'https://api.tavily.com/search')
  assert.equal(seen.body.query, 'hello')
  assert.equal(seen.body.max_results, 3)
  assert.equal(seen.body.api_key, 'tvly-test')
})

test('searchExa surfaces a non-2xx status with the endpoint', async () => {
  await withFetch(async () => new Response('{"error":"bad key"}', { status: 401 }), async () => {
    await assert.rejects(
      () => searchExa({ baseURL: 'https://api.exa.ai', apiKey: 'exa-test', query: 'q' }),
      (error) => error instanceof EngineError
        && error.code === 'WEB_PROVIDER_ERROR'
        && error.message.includes('401')
        && error.message.includes('https://api.exa.ai/search'),
    )
  })
})

test('searchOpencodeGo sends the session header and native web_search tool', async () => {
  let seen
  await withFetch(async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({
      content: [{
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://f.example', title: 'F' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    const result = await searchOpencodeGo({
      baseURL: 'https://opencode.ai/inference/go/anthropic/v1',
      model: 'deepseek-v4.1-flash',
      maxTokens: 4096,
      maxUses: 5,
      apiKey: 'oc_sk_test',
      sessionId: 'session-123',
      query: 'hello',
    })
    assert.equal(result.sources[0].url, 'https://f.example')
  })
  assert.equal(seen.url, 'https://opencode.ai/inference/go/anthropic/v1/messages')
  assert.equal(seen.headers['x-opencode-session'], 'session-123')
  assert.equal(seen.body.tools[0].type, 'web_search_20250305')
  assert.equal(seen.body.tools[0].max_uses, 5)
})

test('an aborted signal settles as WEB_ABORTED', async () => {
  const controller = new AbortController()
  controller.abort('stop')
  await assert.rejects(
    () => searchOpencodeGo({
      baseURL: 'https://example.invalid',
      model: 'm',
      maxTokens: 1,
      maxUses: 1,
      apiKey: 'k',
      query: 'q',
      signal: controller.signal,
    }),
    (error) => error instanceof EngineError && error.code === 'WEB_ABORTED',
  )
})

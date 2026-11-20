import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyLedgerSuggestion,
  fetchLedgerSuggestions,
  forgetLedgerSuggestions,
  onLedgerSuggestionsForgotten,
  relinkBankTransactions,
} from '../ledger-suggestion-client'
import type { LedgerSuggestionView } from '../ledger-suggestion-view'

const COMPANY = 'company-1'
const SELECTION = {
  connection_id: 'conn-1',
  enabled_uids: ['uid-a', 'uid-b'],
  account_mappings: [{ uid: 'uid-a', ledger_account: '1920' }],
}

function suggestion(overrides: Partial<LedgerSuggestionView> = {}): LedgerSuggestionView {
  return { id: 'move:cash-a>1920', kind: 'move', accounts: [], selection: SELECTION, one_click: true, two_connections: false, ...overrides }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type FetchCall = { url: string; method: string; body: unknown }

/** Answers by URL; records every call in order. */
function stubFetch(answers: { suggestions?: () => Response; selection?: () => Response; sweep?: () => Response }) {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.startsWith('/api/cash-accounts/ledger-suggestions')) return (answers.suggestions ?? (() => json({ data: { suggestions: [] } })))()
      if (url === '/api/bank/connections/conn-1/ledgers') return (answers.selection ?? (() => json({ data: { connection_id: 'conn-1', moves: [] } })))()
      if (url === '/api/reconciliation/bank/run') return (answers.sweep ?? (() => json({ data: { applied: 0, suggested: 0 } })))()
      throw new Error(`Unexpected fetch: ${url}`)
    }),
  )
  return calls
}

beforeEach(() => {
  forgetLedgerSuggestions()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchLedgerSuggestions', () => {
  it('reads once per company and connection until the answers are forgotten', async () => {
    const calls = stubFetch({ suggestions: () => json({ data: { suggestions: [suggestion()] } }) })

    expect(await fetchLedgerSuggestions(COMPANY)).toHaveLength(1)
    await fetchLedgerSuggestions(COMPANY)
    await fetchLedgerSuggestions(COMPANY, { connectionId: 'conn 1' })
    expect(calls.map((c) => c.url)).toEqual([
      '/api/cash-accounts/ledger-suggestions',
      '/api/cash-accounts/ledger-suggestions?connection_id=conn%201',
    ])

    forgetLedgerSuggestions()
    await fetchLedgerSuggestions(COMPANY)
    expect(calls).toHaveLength(3)
  })

  it('does not reuse another company\'s answer', async () => {
    const calls = stubFetch({})
    await fetchLedgerSuggestions(COMPANY)
    await fetchLedgerSuggestions('company-2')
    expect(calls).toHaveLength(2)
  })

  it('rejects on a failed read and does not cache the failure', async () => {
    let fail = true
    const calls = stubFetch({ suggestions: () => (fail ? json({ error: { code: 'TRANSIENT_ERROR' } }, 503) : json({ data: { suggestions: [] } })) })

    await expect(fetchLedgerSuggestions(COMPANY)).rejects.toThrow()
    fail = false
    expect(await fetchLedgerSuggestions(COMPANY)).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('tells subscribers when the answers were forgotten, until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = onLedgerSuggestionsForgotten(listener)
    forgetLedgerSuggestions()
    unsubscribe()
    forgetLedgerSuggestions()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('applyLedgerSuggestion', () => {
  it('sends the bank picker request of the suggestion as it is now, then runs the matcher for the moved account', async () => {
    const stale = suggestion({ selection: { ...SELECTION, enabled_uids: ['uid-a'] } })
    const fresh = suggestion()
    let read = 0
    const calls = stubFetch({
      suggestions: () => json({ data: { suggestions: [read++ === 0 ? stale : fresh] } }),
      sweep: () => json({ data: { applied: 46, suggested: 2 } }),
    })
    // What the notice rendered from.
    await fetchLedgerSuggestions(COMPANY)

    const result = await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')

    expect(result).toEqual({ status: 'applied', relinked: { linked: 46, suggested: 2 } })
    expect(calls.slice(1)).toEqual([
      { url: '/api/cash-accounts/ledger-suggestions', method: 'GET', body: undefined },
      // The save: the provider-neutral ledger change (crm#1395), with the
      // suggestion's mappings from the fresh read. It works for an Open
      // Payments connection too, where the Enable Banking route answered 404.
      { url: '/api/bank/connections/conn-1/ledgers', method: 'PATCH', body: { accounts: SELECTION.account_mappings } },
      { url: '/api/reconciliation/bank/run', method: 'POST', body: { account_number: '1920' } },
    ])
  })

  it('runs the matcher once per ledger account of a swap and adds the results up', async () => {
    const swap = suggestion({
      id: 'swap:cash-a>1920|cash-b>1940',
      kind: 'swap',
      selection: {
        ...SELECTION,
        account_mappings: [{ uid: 'uid-a', ledger_account: '1920' }, { uid: 'uid-b', ledger_account: '1940' }],
      },
    })
    const calls = stubFetch({
      suggestions: () => json({ data: { suggestions: [swap] } }),
      sweep: () => json({ data: { applied: 10, suggested: 1 } }),
    })

    expect(await applyLedgerSuggestion(COMPANY, swap.id)).toEqual({ status: 'applied', relinked: { linked: 20, suggested: 2 } })
    expect(calls.filter((c) => c.url === '/api/reconciliation/bank/run').map((c) => c.body)).toEqual([
      { account_number: '1920' },
      { account_number: '1940' },
    ])
  })

  it('answers with the named refusal sentence and runs no sweep when the save is refused', async () => {
    const sentence = 'Bokföringskonto 1920 används redan av bankkontot Sparkonto, som hämtas via en annan bankkoppling. Inget sparades.'
    const calls = stubFetch({
      suggestions: () => json({ data: { suggestions: [suggestion()] } }),
      selection: () => json({ error: { code: 'CASH_ACCOUNT_LEDGER_CLAIMED', message: sentence } }, 409),
    })

    expect(await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')).toEqual({ status: 'refused', reason: sentence })
    expect(calls.some((c) => c.url === '/api/reconciliation/bank/run')).toBe(false)
  })

  it('answers the sentence of a connection that is not active, without running the matcher', async () => {
    const sentence = 'Bankkopplingen är inte aktiv, så bokföringskontot kan inte bytas nu.'
    const calls = stubFetch({
      suggestions: () => json({ data: { suggestions: [suggestion()] } }),
      selection: () => json({ error: { code: 'BANK_LEDGER_CHANGE_NOT_ACTIVE', message: sentence } }, 409),
    })

    expect(await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')).toEqual({ status: 'refused', reason: sentence })
    expect(calls.some((c) => c.url === '/api/reconciliation/bank/run')).toBe(false)
  })

  it('answers refused without a reason when the save cannot be reached or says nothing', async () => {
    stubFetch({
      suggestions: () => json({ data: { suggestions: [suggestion()] } }),
      selection: () => new Response('gateway timeout', { status: 504 }),
    })
    expect(await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')).toEqual({ status: 'refused', reason: null })

    stubFetch({ suggestions: () => json({}, 500) })
    expect(await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')).toEqual({ status: 'refused', reason: null })
  })

  it('saves nothing when the suggestion no longer holds, or cannot be made in one save', async () => {
    for (const current of [[], [suggestion({ one_click: false })], [suggestion({ selection: null, one_click: false, two_connections: true })]]) {
      const calls = stubFetch({ suggestions: () => json({ data: { suggestions: current } }) })
      expect(await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')).toEqual({ status: 'gone' })
      expect(calls.every((c) => c.method === 'GET')).toBe(true)
    }
  })

  it('keeps the change when the matcher cannot run afterwards', async () => {
    stubFetch({
      suggestions: () => json({ data: { suggestions: [suggestion()] } }),
      sweep: () => json({ error: { code: 'UNKNOWN_ERROR' } }, 500),
    })

    expect(await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')).toEqual({ status: 'applied', relinked: null })
  })

  it('forgets the cached suggestions once the save went through', async () => {
    const calls = stubFetch({ suggestions: () => json({ data: { suggestions: [suggestion()] } }) })
    const listener = vi.fn()
    const unsubscribe = onLedgerSuggestionsForgotten(listener)

    await applyLedgerSuggestion(COMPANY, 'move:cash-a>1920')
    unsubscribe()
    await fetchLedgerSuggestions(COMPANY)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.url === '/api/cash-accounts/ledger-suggestions')).toHaveLength(2)
  })
})

describe('relinkBankTransactions', () => {
  it('answers null when the matcher request throws, and asks nothing for no ledger account', async () => {
    const offline = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', offline)
    expect(await relinkBankTransactions(['1920'])).toBeNull()

    offline.mockClear()
    expect(await relinkBankTransactions([])).toEqual({ linked: 0, suggested: 0 })
    expect(offline).not.toHaveBeenCalled()
  })
})

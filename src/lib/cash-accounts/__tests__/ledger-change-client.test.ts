import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLedgerChange, LedgerChangeError, previewLedgerChange } from '../ledger-change-client'

const MOVE = {
  uid: 'uid-pg',
  name: 'Plusgirokonto',
  iban_last4: '4308',
  currency: 'SEK',
  cash_account_id: 'cash-1',
  from_ledger: '1931',
  to_ledger: '1920',
  booked_rows: 0,
  unbooked_rows: 41,
  swapped: false,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ledger change client', () => {
  it('previews with dry_run and applies without it, on the connection named', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: { connection_id: 'conn 1', moves: [MOVE] } }))
    vi.stubGlobal('fetch', fetchMock)
    const accounts = [{ uid: 'uid-pg', ledger_account: '1920' }]

    expect(await previewLedgerChange('conn 1', accounts)).toEqual([MOVE])
    expect(await applyLedgerChange('conn 1', accounts)).toEqual([MOVE])

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
      ['/api/bank/connections/conn%201/ledgers?dry_run=true', 'PATCH', { accounts }],
      ['/api/bank/connections/conn%201/ledgers', 'PATCH', { accounts }],
    ])
  })

  it('throws the server\'s sentence on a refusal, and no sentence when there is none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'CASH_ACCOUNT_LEDGER_CLAIMED', message: 'Bokföringskonto 1920 används redan.' } }, 409)))
    await expect(applyLedgerChange('conn-1', [{ uid: 'a', ledger_account: '1920' }])).rejects.toMatchObject({
      name: 'LedgerChangeError',
      reason: 'Bokföringskonto 1920 används redan.',
      status: 409,
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway timeout', { status: 504 })))
    await expect(previewLedgerChange('conn-1', [{ uid: 'a', ledger_account: '1920' }])).rejects.toMatchObject({ reason: null, status: 504 })

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const error = await applyLedgerChange('conn-1', [{ uid: 'a', ledger_account: '1920' }]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LedgerChangeError)
    expect((error as LedgerChangeError).reason).toBeNull()
  })
})

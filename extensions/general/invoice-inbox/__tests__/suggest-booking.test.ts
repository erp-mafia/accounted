/**
 * What this underlag would be booked as.
 *
 * The route is read-only and advisory: it proposes, the user approves, and the
 * posting still goes through book-direct. So the tests are mostly about what it
 * must NOT do — propose beside an already-posted verifikat, invent a booking for
 * an unmatched document, or turn an unmappable transaction into an error the
 * user cannot act on.
 *
 * The lines themselves come from buildTransactionEntryLines, which is the same
 * function the commit path uses. That is deliberate and is the one thing worth
 * asserting about them: what is shown cannot drift from what gets posted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const evaluateMappingRules = vi.fn()
vi.mock('@/lib/bookkeeping/mapping-engine', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  evaluateMappingRules: (...a: unknown[]) => evaluateMappingRules(...a),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))

const route = invoiceInboxExtension.apiRoutes!.find(
  (r) => r.method === 'POST' && r.path === '/items/:id/suggest-booking',
)!

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

const req = () =>
  createMockRequest('/items/item-1/suggest-booking', {
    method: 'POST',
    searchParams: { _id: 'item-1' },
  })

/** An ordinary domestic expense the konteringskarta already recognises. */
function mappingResult(over: Record<string, unknown> = {}) {
  return {
    rule: null,
    template_id: 'tmpl-1',
    debit_account: '5410',
    credit_account: '1930',
    risk_level: 'low',
    confidence: 0.92,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Elgiganten',
    ...over,
  }
}

function transaction(over: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    company_id: 'company-1',
    date: '2026-08-04',
    amount: -21639,
    amount_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    cash_account_id: null,
    journal_entry_id: null,
    description: 'Elgiganten Aktiebolag K3667',
    ...over,
  }
}

/** item row + transaction row + company_settings row, in query order. */
function queueRows(
  mock: ReturnType<typeof createQueuedMockSupabase>,
  opts: { item?: Record<string, unknown>; tx?: Record<string, unknown>; entityType?: string } = {},
) {
  mock.enqueue({
    data: {
      id: 'item-1',
      matched_transaction_id: 'tx-1',
      created_journal_entry_id: null,
      created_supplier_invoice_id: null,
      ...opts.item,
    },
  })
  mock.enqueue({ data: transaction(opts.tx) })
  mock.enqueue({ data: { entity_type: opts.entityType ?? 'aktiebolag' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  evaluateMappingRules.mockResolvedValue(mappingResult())
})

describe('POST /items/:id/suggest-booking', () => {
  it('returns 401 without a context', async () => {
    expect((await route.handler(req())).status).toBe(401)
  })

  it('returns 404 for an item in another company', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })
    const res = await route.handler(req(), buildCtx(mock.supabase))
    expect(res.status).toBe(404)
  })

  it('proposes nothing once the item is already booked', async () => {
    // A suggestion beside a posted verifikat is an invitation to book twice.
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: { id: 'item-1', matched_transaction_id: 'tx-1', created_journal_entry_id: 'je-1', created_supplier_invoice_id: null },
    })
    const res = await route.handler(req(), buildCtx(mock.supabase))
    const { body } = await parseJsonResponse<{ data: { source: string; lines: unknown[] } }>(res)
    expect(body.data.source).toBe('already_booked')
    expect(body.data.lines).toEqual([])
    expect(evaluateMappingRules).not.toHaveBeenCalled()
  })

  it('proposes nothing when the item became a supplier invoice', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: { id: 'item-1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: 'si-1' },
    })
    const { body } = await parseJsonResponse<{ data: { source: string } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.source).toBe('already_booked')
  })

  it('says so honestly when nothing is matched yet', async () => {
    // No transaction means no trusted amount, no settlement account and no
    // learned counterparty. Guessing here would be worse than saying nothing.
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: { id: 'item-1', matched_transaction_id: null, created_journal_entry_id: null, created_supplier_invoice_id: null },
    })
    const { body } = await parseJsonResponse<{ data: { source: string; lines: unknown[] } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.source).toBe('no_transaction')
    expect(body.data.lines).toEqual([])
    expect(evaluateMappingRules).not.toHaveBeenCalled()
  })

  it('returns balanced lines for a matched transaction', async () => {
    const mock = createQueuedMockSupabase()
    queueRows(mock)

    const { body } = await parseJsonResponse<{
      data: { source: string; lines: { debit_amount: number; credit_amount: number }[]; entry_date: string }
    }>(await route.handler(req(), buildCtx(mock.supabase)))

    expect(body.data.source).toBe('booking_template')
    expect(body.data.lines.length).toBeGreaterThan(0)
    const debit = body.data.lines.reduce((t, l) => t + (l.debit_amount || 0), 0)
    const credit = body.data.lines.reduce((t, l) => t + (l.credit_amount || 0), 0)
    expect(Math.round((debit - credit) * 100)).toBe(0)
  })

  it('books on the day the money moved, not the day on the document', async () => {
    const mock = createQueuedMockSupabase()
    queueRows(mock, { tx: { date: '2026-08-04' } })
    const { body } = await parseJsonResponse<{ data: { entry_date: string } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.entry_date).toBe('2026-08-04')
  })

  it('carries the review flags the "Varför så här?" fold reads', async () => {
    evaluateMappingRules.mockResolvedValue(
      mappingResult({ confidence: 0.55, requires_review: true, direction_mismatch: true, template_id: undefined, rule: { rule_name: 'Drivmedel' } }),
    )
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    const { body } = await parseJsonResponse<{
      data: { source: string; confidence: number; requires_review: boolean; direction_mismatch: boolean; rule_name: string }
    }>(await route.handler(req(), buildCtx(mock.supabase)))

    expect(body.data.source).toBe('mapping_rule')
    expect(body.data.confidence).toBe(0.55)
    expect(body.data.requires_review).toBe(true)
    // A refund matching an expense-learned template: mirrored and review-gated
    // upstream, and the pane must be able to say so.
    expect(body.data.direction_mismatch).toBe(true)
    expect(body.data.rule_name).toBe('Drivmedel')
  })

  it('degrades to no proposal when neither side of the mapping resolves', async () => {
    // Real for a company with no rule and no history. Not an error the user
    // can act on, so it must not read as one.
    evaluateMappingRules.mockResolvedValue(mappingResult({ debit_account: '', credit_account: '' }))
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    const res = await route.handler(req(), buildCtx(mock.supabase))
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { source: string; lines: unknown[] } }>(res)
    expect(body.data.source).toBe('no_mapping')
    expect(body.data.lines).toEqual([])
  })

  it('still hands the dialog the bank amount when there is no proposal', async () => {
    // The 2026-08-12 regression: unknown supplier meant an empty proposal,
    // and the manual-booking dialog opened with no amount at all. An empty
    // proposal must still carry the matched row's kronor figure, its date,
    // and a balanced two-row skeleton against the settlement account.
    evaluateMappingRules.mockResolvedValue(mappingResult({ debit_account: '', credit_account: '' }))
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    const { body } = await parseJsonResponse<{
      data: {
        entry_date: string
        transaction: { amount_sek: number; date: string }
        fallback_lines: { account_number: string; debit_amount: number; credit_amount: number }[]
      }
    }>(await route.handler(req(), buildCtx(mock.supabase)))

    expect(body.data.entry_date).toBe('2026-08-04')
    expect(body.data.transaction).toEqual({ amount_sek: -21639, date: '2026-08-04' })
    expect(body.data.fallback_lines).toEqual([
      { account_number: '', debit_amount: 21639, credit_amount: 0, description: '' },
      { account_number: '1930', debit_amount: 0, credit_amount: 21639, description: '' },
    ])
  })

  it('builds the skeleton from the SEK amount on a withheld foreign proposal', async () => {
    // currency_unsupported hides the rule's wrong VAT, but the bank row's SEK
    // amount is still the one honest kronor figure and must reach the dialog.
    evaluateMappingRules.mockResolvedValue(mappingResult({ rule: { rule_name: 'ACME' }, template_id: undefined }))
    const mock = createQueuedMockSupabase()
    queueRows(mock, { tx: { amount: -100, amount_sek: -1150, currency: 'EUR', exchange_rate: 11.5 } })
    const { body } = await parseJsonResponse<{
      data: {
        source: string
        transaction: { amount_sek: number }
        fallback_lines: { debit_amount: number; credit_amount: number }[]
      }
    }>(await route.handler(req(), buildCtx(mock.supabase)))

    expect(body.data.source).toBe('currency_unsupported')
    expect(body.data.transaction.amount_sek).toBe(-1150)
    expect(body.data.fallback_lines[0].debit_amount).toBe(1150)
    expect(body.data.fallback_lines[1].credit_amount).toBe(1150)
  })

  it('degrades rather than 500s when the mapping engine throws', async () => {
    evaluateMappingRules.mockRejectedValue(new Error('boom'))
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    const res = await route.handler(req(), buildCtx(mock.supabase))
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{
      data: { source: string; fallback_lines: { account_number: string; credit_amount: number }[] }
    }>(res)
    expect(body.data.source).toBe('no_mapping')
    // Even here the dialog gets the amount: the settlement resolution may be
    // what threw, so the skeleton falls back to the 1930 default.
    expect(body.data.fallback_lines).toEqual([
      { account_number: '', debit_amount: 21639, credit_amount: 0, description: '' },
      { account_number: '1930', debit_amount: 0, credit_amount: 21639, description: '' },
    ])
  })

  it('proposes nothing when the bank line already has a verifikat', async () => {
    // The inbox row is not the only way a purchase gets booked. Booking from
    // Transaktioner, bulk-book or MCP leaves created_journal_entry_id null on
    // the inbox row, so trusting that row alone proposes a second verifikat
    // for money that already has one.
    const mock = createQueuedMockSupabase()
    queueRows(mock, { tx: { journal_entry_id: 'je-9' } })
    const { body } = await parseJsonResponse<{ data: { source: string; lines: unknown[] } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.source).toBe('already_booked')
    expect(body.data.lines).toEqual([])
    expect(evaluateMappingRules).not.toHaveBeenCalled()
  })

  it('tells the mapping engine which entity type the company is', async () => {
    // Left undefined, the engine proposed enskild-firma accounts to an
    // aktiebolag: 2013 instead of 2893 for an owner expense.
    const mock = createQueuedMockSupabase()
    queueRows(mock, { entityType: 'aktiebolag' })
    await route.handler(req(), buildCtx(mock.supabase))
    expect(evaluateMappingRules).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ id: 'tx-1' }),
      'aktiebolag',
      expect.anything(),
    )
  })

  it('falls back to enskild firma when no entity type is stored', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: { id: 'item-1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null },
    })
    mock.enqueue({ data: transaction() })
    mock.enqueue({ data: null })
    await route.handler(req(), buildCtx(mock.supabase))
    expect(evaluateMappingRules).toHaveBeenCalledWith(
      expect.anything(), 'company-1', expect.anything(), 'enskild_firma', expect.anything(),
    )
  })

  it('does not apply the settlement account a second time', async () => {
    // evaluateMappingRules applies it on every return path. Applying it again
    // rewrote a legitimate 1930 leg, collapsing an own-account transfer onto
    // a single account.
    evaluateMappingRules.mockResolvedValue(
      mappingResult({ debit_account: '1930', credit_account: '1931', template_id: undefined, confidence: 0.85 }),
    )
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    const { body } = await parseJsonResponse<{ data: { lines: { account_number: string }[] } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    const accounts = body.data.lines.map((l) => l.account_number)
    expect(accounts).toContain('1930')
    expect(accounts).toContain('1931')
  })

  it('reports the engine placeholder as no proposal, not as an answer', async () => {
    // getDefaultResult is how the engine says it has nothing: 6991 at
    // confidence 0.1. Rendering it dresses "no idea" up as a kontering.
    evaluateMappingRules.mockResolvedValue(
      mappingResult({ rule: null, template_id: undefined, debit_account: '6991', confidence: 0.1, requires_review: true }),
    )
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    const { body } = await parseJsonResponse<{ data: { source: string; lines: unknown[] } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.source).toBe('no_mapping')
    expect(body.data.lines).toEqual([])
  })

  it('calls a learned counterparty match what it is', async () => {
    // template_id marks a STATIC library template; a learned konteringskarta
    // match sets neither field. Read the other way round, the company's most
    // trusted proposal was labelled 'default'.
    evaluateMappingRules.mockResolvedValue(
      mappingResult({ rule: null, template_id: undefined, confidence: 0.85 }),
    )
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    const { body } = await parseJsonResponse<{ data: { source: string } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.source).toBe('counterparty_template')
  })

  it('withholds a rule-branch proposal on a foreign-currency row', async () => {
    // mapping-engine computes rule-branch VAT from the transaction's own
    // currency while every other line is SEK, so 100 EUR at 11.5 shows 20 kr
    // of moms instead of 230. The entry balances, so nothing downstream
    // catches it. A wrong number one click from the ledger is worse than none.
    evaluateMappingRules.mockResolvedValue(mappingResult({ rule: { rule_name: 'ACME' }, template_id: undefined }))
    const mock = createQueuedMockSupabase()
    queueRows(mock, { tx: { amount: -100, amount_sek: -1150, currency: 'EUR', exchange_rate: 11.5 } })
    const { body } = await parseJsonResponse<{ data: { source: string; lines: unknown[] } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.source).toBe('currency_unsupported')
    expect(body.data.lines).toEqual([])
  })

  it('still proposes on a foreign row when the match came from the konteringskarta', async () => {
    // Counterparty and static-template paths convert to SEK before generating
    // VAT, so only the rule branch is withheld.
    evaluateMappingRules.mockResolvedValue(mappingResult({ rule: null, template_id: undefined, confidence: 0.85 }))
    const mock = createQueuedMockSupabase()
    queueRows(mock, { tx: { amount: -100, amount_sek: -1150, currency: 'EUR', exchange_rate: 11.5 } })
    const { body } = await parseJsonResponse<{ data: { source: string; lines: unknown[] } }>(
      await route.handler(req(), buildCtx(mock.supabase)),
    )
    expect(body.data.source).toBe('counterparty_template')
    expect(body.data.lines.length).toBeGreaterThan(0)
  })

  it('reports a database failure as a failure, not as a missing document', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null, error: { message: 'column does not exist' } })
    const res = await route.handler(req(), buildCtx(mock.supabase))
    expect(res.status).toBe(500)
  })

  it('scopes every read to the company', async () => {
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    await route.handler(req(), buildCtx(mock.supabase))
    const scoped = mock.calls.filter(
      (c) => c.method === 'eq' && c.args?.[0] === 'company_id' && c.args?.[1] === 'company-1',
    )
    // invoice_inbox_items, transactions and company_settings.
    expect(scoped.length).toBeGreaterThanOrEqual(3)
  })

  it('never writes', async () => {
    const mock = createQueuedMockSupabase()
    queueRows(mock)
    await route.handler(req(), buildCtx(mock.supabase))
    for (const m of ['insert', 'update', 'upsert', 'delete']) {
      expect(mock.calls.some((c) => c.method === m), `route called .${m}()`).toBe(false)
    }
  })
})

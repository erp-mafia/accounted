/**
 * The agent's worklist. What matters: both sources land in one list ranked on
 * SEK value, a verifikat gets a searchable name from what it books, a target
 * that already has a staged link is not offered twice, and rows that never
 * have a mailed receipt are flagged instead of searched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetchCandidateTransactions = vi.fn()
vi.mock('../hunt', () => ({
  fetchCandidateTransactions: (...args: unknown[]) => mockFetchCandidateTransactions(...args),
}))

import { resolveAgentWorklist } from '../agent-worklist'

type Row = Record<string, unknown>

function mockSupabase(tables: Record<string, Row[]>, rpc: unknown) {
  const client = {
    rpc: vi.fn(() => Promise.resolve({ data: rpc, error: null })),
    from(table: string) {
      let from = 0
      let to = Number.MAX_SAFE_INTEGER
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order']) chain[m] = vi.fn(() => chain)
      chain.range = vi.fn((f: number, t: number) => {
        from = f
        to = t
        return chain
      })
      chain.maybeSingle = vi.fn(() => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }))
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: (tables[table] ?? []).slice(from, to + 1), error: null }).then(resolve)
      return chain
    },
  }
  return client as never
}

const VERIFIKAT = [
  {
    journal_entry_id: 'je-si',
    voucher_series: 'A',
    voucher_number: 217,
    entry_date: '2026-03-10',
    description: 'Leverantörsfaktura 4411',
    source_type: 'supplier_invoice_registered',
    gross_amount: 1249,
  },
  {
    journal_entry_id: 'je-bank',
    voucher_series: 'A',
    voucher_number: 218,
    entry_date: '2026-03-12',
    description: 'Kortköp HETZNER ONLINE GMBH',
    source_type: 'bank_transaction',
    gross_amount: 560,
  },
  {
    journal_entry_id: 'je-claimed',
    voucher_series: 'A',
    voucher_number: 219,
    entry_date: '2026-03-13',
    description: 'Kortköp Clas Ohlson',
    source_type: 'bank_transaction',
    gross_amount: 9999,
  },
]

function fixture(): Record<string, Row[]> {
  return {
    pending_operations: [{ params: { journal_entry_id: 'je-claimed', document_id: 'doc-9' } }],
    company_inboxes: [{ local_part: 'acme-7f3k' }],
    supplier_invoices: [
      {
        registration_journal_entry_id: 'je-si',
        supplier_invoice_number: '4411',
        total: 1249,
        currency: 'SEK',
        supplier: { name: 'Kontorsgiganten AB' },
      },
    ],
    transactions: [{ journal_entry_id: 'je-bank', merchant_name: 'Hetzner', amount: -49, currency: 'EUR' }],
  }
}

const UNBOOKED = {
  id: 'tx-1',
  company_id: 'co-1',
  date: '2026-03-15',
  description: 'GOOGLE WORKSPACE ACME',
  merchant_name: null,
  amount: -90,
  currency: 'USD',
  amount_sek: -950,
  exchange_rate: 10.55,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
  mockFetchCandidateTransactions.mockResolvedValue([UNBOOKED])
})

afterEach(() => {
  delete process.env.RESEND_INBOUND_DOMAIN
})

describe('resolveAgentWorklist', () => {
  it('merges verifikat and unbooked purchases, ranked on SEK value', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const result = await resolveAgentWorklist(supabase, 'co-1')

    // 1249 SEK, then USD 90 (950 SEK), then EUR 49 (560 SEK): the foreign
    // amounts must not sort as if they were kronor.
    expect(result.items.map((i) => i.journal_entry_id ?? i.transaction_id)).toEqual(['je-si', 'tx-1', 'je-bank'])
    expect(result.inbox_address).toBe('acme-7f3k@in.example.test')
  })

  it('names the verifikat after the supplier invoice or bank row it books', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    const si = items.find((i) => i.journal_entry_id === 'je-si')!
    expect(si).toMatchObject({
      kind: 'verifikat',
      voucher: 'A217',
      counterparty: 'Kontorsgiganten AB',
      invoice_number: '4411',
      amount: 1249,
      currency: 'SEK',
      search_to: '2026-03-20',
    })
    const bank = items.find((i) => i.journal_entry_id === 'je-bank')!
    expect(bank).toMatchObject({ counterparty: 'Hetzner', amount: 49, currency: 'EUR' })
  })

  it('skips a target that already has a staged or settled link', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const result = await resolveAgentWorklist(supabase, 'co-1')

    expect(result.items.some((i) => i.journal_entry_id === 'je-claimed')).toBe(false)
    // 3 verifikat minus the claimed one, plus the unbooked purchase.
    expect(result.total_count).toBe(3)
  })

  it('skips a verifikat claimed inside a staged bulk link', async () => {
    const tables = fixture()
    tables.pending_operations = [{ params: { links: [{ document_id: 'doc-3', journal_entry_id: 'je-bank' }] } }]
    const supabase = mockSupabase(tables, { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    expect(items.some((i) => i.journal_entry_id === 'je-bank')).toBe(false)
    expect(items.some((i) => i.journal_entry_id === 'je-claimed')).toBe(true)
  })

  it('points at the vendor portal instead of the mailbox when the vendor does not mail invoices', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    const workspace = items.find((i) => i.transaction_id === 'tx-1')!
    expect(workspace.portal).toMatchObject({ vendor: 'Google Workspace', url: 'https://admin.google.com' })
    const si = items.find((i) => i.journal_entry_id === 'je-si')!
    expect(si.portal).toBeNull()
  })

  it('flags rows that never have a mailed receipt', async () => {
    mockFetchCandidateTransactions.mockResolvedValue([
      { ...UNBOOKED, id: 'tx-tax', description: 'Skatteverket', amount: -5000, currency: 'SEK', amount_sek: -5000 },
    ])
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 0, verifikat: [] })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    expect(items[0]).toMatchObject({ transaction_id: 'tx-tax', mail_searchable: false, portal: null })
  })

  it('opens the window 45 days back for a payment that settles an invoice', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    // The invoice is mailed when it is issued and paid on the due date, so a
    // symmetric window around the payment never reaches it.
    const invoice = items.find((i) => i.journal_entry_id === 'je-si')!
    expect(invoice.search_from).toBe('2026-01-24')
    expect(invoice.search_to).toBe('2026-03-20')
    // A card purchase invoiced nothing: it keeps the tight window.
    const card = items.find((i) => i.journal_entry_id === 'je-bank')!
    expect(card.search_from).toBe('2026-03-02')
  })

  it('marks a restaurant charge as one that may carry a tip', async () => {
    mockFetchCandidateTransactions.mockResolvedValue([
      { ...UNBOOKED, id: 'tx-rest', description: 'JORA RESTAURANG AB', currency: 'SEK', amount: -4002.9, amount_sek: -4002.9 },
    ])
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 0, verifikat: [] })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    expect(items[0]).toMatchObject({ transaction_id: 'tx-rest', tip_possible: true })
    expect(items[0].next_step).toMatch(/fota/i)
  })

  it('gives every item one next step naming where the receipt is', async () => {
    mockFetchCandidateTransactions.mockResolvedValue([
      { ...UNBOOKED, id: 'tx-kivra', description: 'ICA MAXI', currency: 'SEK', amount: -412.5, amount_sek: -412.5 },
      { ...UNBOOKED, id: 'tx-tax', description: 'Skatteverket', currency: 'SEK', amount: -5000, amount_sek: -5000 },
      UNBOOKED,
      { ...UNBOOKED, id: 'tx-plain', description: 'POSTIZ', currency: 'SEK', amount: -377.87, amount_sek: -377.87 },
    ])
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 0, verifikat: [] })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')
    const step = (id: string) => items.find((i) => i.transaction_id === id)!.next_step

    expect(step('tx-kivra')).toMatch(/Kivra/)
    expect(step('tx-tax')).toMatch(/lönespecifikationen/)
    expect(step('tx-1')).toContain('https://admin.google.com')
    expect(step('tx-plain')).toMatch(/kvittoadressen/)
    // The sentence is an errand for the reader, never a report of what was tried.
    for (const item of items) expect(item.next_step).not.toMatch(/sökte|hittade|agent/i)
  })

  it('honours limit and answers no inbox address when none is configured', async () => {
    delete process.env.RESEND_INBOUND_DOMAIN
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const result = await resolveAgentWorklist(supabase, 'co-1', { limit: 1 })

    expect(result.items).toHaveLength(1)
    expect(result.total_count).toBe(3)
    expect(result.inbox_address).toBeNull()
  })

  it('throws when the RPC reports not-ok', async () => {
    const supabase = mockSupabase(fixture(), { ok: false, code: 'forbidden' })
    await expect(resolveAgentWorklist(supabase, 'co-1')).rejects.toThrow('forbidden')
  })
})

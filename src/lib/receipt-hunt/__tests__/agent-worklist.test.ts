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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nextStepKind, resolveAgentWorklist, UNDERLAG_ARCHIVED_ELSEWHERE_REASON } from '../agent-worklist'

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
  it('puts unbooked purchases before verifikat, each ranked on SEK value', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const result = await resolveAgentWorklist(supabase, 'co-1')

    // The unbooked USD 90 purchase leads although 1249 SEK is larger; then
    // 1249 SEK before EUR 49 (560 SEK): foreign amounts are ranked in kronor.
    expect(result.items.map((i) => i.journal_entry_id ?? i.transaction_id)).toEqual(['tx-1', 'je-si', 'je-bank'])
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

  it("points at the company's own portal for a supplier it added, and says so in the next step", async () => {
    const tables = fixture()
    tables.company_portals = [
      { id: 'p-kg', counterparty_key: 'kontorsgiganten', vendor_name: 'Kontorsgiganten', url: 'https://mina.kontorsgiganten.se/fakturor' },
    ]
    const supabase = mockSupabase(tables, { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    const si = items.find((i) => i.journal_entry_id === 'je-si')!
    expect(si.portal).toEqual({ vendor: 'Kontorsgiganten', url: 'https://mina.kontorsgiganten.se/fakturor', note: null })
    expect(si.next_step).toBe('Logga in på Kontorsgiganten och ladda ner fakturan: https://mina.kontorsgiganten.se/fakturor')
    // The directory still answers for the rest.
    expect(items.find((i) => i.transaction_id === 'tx-1')!.portal).toMatchObject({ vendor: 'Google Workspace' })
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

  it('pages with offset and next_offset over one stable ranking (feedback seq 957595)', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const full = await resolveAgentWorklist(supabase, 'co-1')
    expect(full.next_offset).toBeUndefined()

    const first = await resolveAgentWorklist(supabase, 'co-1', { limit: 2 })
    expect(first.next_offset).toBe(2)
    const second = await resolveAgentWorklist(supabase, 'co-1', { limit: 2, offset: first.next_offset })
    expect(second.next_offset).toBeUndefined()

    const paged = [...first.items, ...second.items].map((i) => i.journal_entry_id ?? i.transaction_id)
    expect(paged).toEqual(full.items.map((i) => i.journal_entry_id ?? i.transaction_id))
    expect(second.total_count).toBe(full.total_count)
  })

  it('answers an empty page past the end instead of wrapping around', async () => {
    const supabase = mockSupabase(fixture(), { ok: true, total_count: 3, verifikat: VERIFIKAT })
    const result = await resolveAgentWorklist(supabase, 'co-1', { limit: 5, offset: 10 })

    expect(result.items).toEqual([])
    expect(result.next_offset).toBeUndefined()
  })

  it('ranks over more than one RPC page, so an older large verifikat is reachable', async () => {
    // The RPC returns at most 100 rows, most recent first. The worklist used
    // to rank only that first page, so nothing past it could ever be worked.
    const row = (n: number, gross: number) => ({
      journal_entry_id: `je-${n}`,
      voucher_series: 'A',
      voucher_number: n,
      entry_date: '2026-03-01',
      description: 'Kortköp',
      source_type: 'bank_transaction',
      gross_amount: gross,
    })
    const recent = Array.from({ length: 100 }, (_, i) => row(i + 1, 100 + i))
    const older = [row(101, 50_000), ...Array.from({ length: 19 }, (_, i) => row(102 + i, 10))]
    const supabase = mockSupabase({ ...fixture(), pending_operations: [] }, null)
    const rpc = vi.fn((_fn: string, args: { p_offset: number }) =>
      Promise.resolve({
        data: { ok: true, total_count: 120, verifikat: args.p_offset === 0 ? recent : older },
        error: null,
      }),
    )
    ;(supabase as unknown as { rpc: unknown }).rpc = rpc
    mockFetchCandidateTransactions.mockResolvedValue([])

    const result = await resolveAgentWorklist(supabase, 'co-1', { limit: 100 })

    expect(rpc.mock.calls.map(([, args]) => args.p_offset)).toEqual([0, 100])
    expect(result.items[0].journal_entry_id).toBe('je-101')
    expect(result.total_count).toBe(120)
    expect(result.next_offset).toBe(100)
    const rest = await resolveAgentWorklist(supabase, 'co-1', { limit: 100, offset: 100 })
    expect(rest.items).toHaveLength(20)
    expect(rest.next_offset).toBeUndefined()
  })

  it('throws when the RPC reports not-ok', async () => {
    const supabase = mockSupabase(fixture(), { ok: false, code: 'forbidden' })
    await expect(resolveAgentWorklist(supabase, 'co-1')).rejects.toThrow('forbidden')
  })
})

/**
 * Shaped like the rows of a trial run (2026-10-28): the bank rows behind them
 * had no merchant name, so each verifikat was read by its description, and
 * the lines say what it actually booked.
 */
describe('resolveAgentWorklist: what a verifikat booked', () => {
  const verifikat = (n: number, description: string, gross: number) => ({
    journal_entry_id: `je-${n}`,
    voucher_series: 'A',
    voucher_number: n,
    entry_date: '2026-09-29',
    description,
    source_type: 'bank_transaction',
    gross_amount: gross,
  })
  const line = (n: number, account_number: string, debit: number, credit = 0) => ({
    journal_entry_id: `je-${n}`,
    account_number,
    debit_amount: debit,
    credit_amount: credit,
  })

  async function worklist(rows: ReturnType<typeof verifikat>[], lines: Row[]) {
    mockFetchCandidateTransactions.mockResolvedValue([])
    const supabase = mockSupabase(
      {
        ...fixture(),
        pending_operations: [],
        supplier_invoices: [],
        // The bank row exists but names nobody: Swedbank leaves merchant_name empty.
        transactions: rows.map((r) => ({ journal_entry_id: r.journal_entry_id, merchant_name: null, amount: -r.gross_amount, currency: 'SEK' })),
        journal_entry_lines: lines,
      },
      { ok: true, total_count: rows.length, verifikat: rows },
    )
    const { items } = await resolveAgentWorklist(supabase, 'co-1')
    return (n: number) => items.find((i) => i.journal_entry_id === `je-${n}`)!
  }

  it('searches mail for a purchase whose description notes its VAT', async () => {
    const item = await worklist(
      [
        verifikat(1, 'Flyg SF KLM · KLM flyg Stockholm-New York, tjänsteresa. Utrikes flyg 0% moms. Kvitto saknas i Accounted.', 12000),
        verifikat(2, 'Partners on Booking BV K1234 · Booking.com, logi tjänsteresa. Utländsk logi, ingen avdragsgill moms.', 9000),
        verifikat(3, 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO · Claude-abonnemang. Omvänd skattskyldighet.', 2000),
        verifikat(4, 'OPENAI *CHATGPT SUBSCR K1234 · ChatGPT Pro. 0% debiterad moms: omvänd skattskyldighet.', 1800),
      ],
      [
        line(1, '1930', 0, 12000), line(1, '5890', 12000),
        line(2, '1930', 0, 9000), line(2, '5890', 9000),
        line(3, '1930', 0, 2000), line(3, '2614', 0, 500), line(3, '2645', 500), line(3, '5420', 2000),
        line(4, '1930', 0, 1800), line(4, '2614', 0, 450), line(4, '2645', 450), line(4, '5420', 1800),
      ],
    )

    for (const n of [1, 2, 3]) {
      expect(item(n)).toMatchObject({ mail_searchable: true, next_step: 'Leta i mejlen och vidarebefordra kvittot till kvittoadressen.' })
    }
    expect(item(4)).toMatchObject({ mail_searchable: true, portal: { vendor: 'OpenAI' } })
  })

  it('skips a share issue, a transfer between own accounts and a Stripe sales verifikat: they bought nothing', async () => {
    const item = await worklist(
      [
        verifikat(11, 'SWED260727ABCDEF · Inbetalning nyemission. Omförs till 2081/2097 vid registrering.', 100000),
        verifikat(12, 'Omklassificering av intern överföring sparkonto till företagskonto.', 80000),
        verifikat(13, 'Överföring internt · Intern överföring 1931 -> 1930, motsvarande insättning bokad mot 2082.', 60000),
        verifikat(14, 'Stripe kortförsäljning 2026-10-27, samlingsverifikat (6 betalningar)', 5000),
      ],
      [
        line(11, '1931', 100000), line(11, '2082', 0, 100000),
        line(12, '1930', 0, 80000), line(12, '1940', 80000),
        line(13, '1931', 0, 60000), line(13, '2082', 60000),
        line(14, '1686', 5000), line(14, '2611', 0, 1000), line(14, '3001', 0, 4000),
      ],
    )

    for (const n of [11, 12, 13, 14]) {
      expect(item(n)).toMatchObject({
        mail_searchable: false,
        portal: null,
        next_step: 'Inget inköp, så inget kvitto: underlaget är kontoutdraget eller betalleverantörens rapport.',
      })
    }
  })

  it('keeps the skattekonto errand for a tax payment, and lets the words decide on salary', async () => {
    const item = await worklist(
      [
        verifikat(21, 'Inbetalning skat BG 0000050501055 · Inbetalning till skattekontot, avser AGI juli', 30000),
        verifikat(22, 'Löneutbetalning: 2026.K.08 - anställd: 1', 40000),
      ],
      [
        line(21, '1630', 30000), line(21, '1930', 0, 30000),
        line(22, '7210', 52000), line(22, '2710', 0, 12000), line(22, '1930', 0, 40000),
      ],
    )

    for (const n of [21, 22]) {
      expect(item(n)).toMatchObject({
        mail_searchable: false,
        next_step: 'Hämtas inte ur mejlen: underlaget är lönespecifikationen, skattekontot eller kontoutdraget.',
      })
    }
  })

  // crm#1582: ~180 SIE-imported purchases whose underlag the former byrå kept
  // on paper were sent to a mail search that could never find them.
  it('sends no mail search for an imported verifikat: it points at the waiver for underlag kept with the earlier books', async () => {
    const imported = (n: number, description: string, gross: number) => ({ ...verifikat(n, description, gross), source_type: 'import' })
    const item = await worklist(
      [
        imported(41, 'Kortköp Clas Ohlson', 900),
        imported(42, 'Hetzner Online GmbH', 600),
        imported(43, 'Lön augusti', 30000),
        verifikat(44, 'Hetzner Online GmbH', 600),
      ],
      [
        line(41, '1930', 0, 900), line(41, '5410', 720), line(41, '2641', 180),
        line(42, '1930', 0, 600), line(42, '6540', 600),
        line(43, '1930', 0, 30000), line(43, '7210', 30000),
        line(44, '1930', 0, 600), line(44, '6540', 600),
      ],
    )

    for (const n of [41, 42, 43]) {
      expect(item(n)).toMatchObject({ mail_searchable: false, portal: null, underlag_on: null })
      expect(item(n).next_step).toContain(`"${UNDERLAG_ARCHIVED_ELSEWHERE_REASON}"`)
    }
    // The same purchase booked in Accounted is still worth a mail search.
    expect(item(44)).toMatchObject({ mail_searchable: true })
  })

  it('counts a refund and a verifikat that debits only input VAT as purchases', async () => {
    const item = await worklist(
      [
        // Money in, but a cost is credited: the vendor's credit note is the underlag.
        verifikat(31, 'BOOKING.COM · Återbetalning avbokat hotell', 1120),
        // A ledger mirrored from another system books the purchase's VAT and nothing else.
        verifikat(32, 'PAYPAL *MICROSOFT,4029357733,IE · spegling av annan kontering', 2400),
      ],
      [
        line(31, '1930', 1120), line(31, '5890', 0, 1000), line(31, '2641', 0, 120),
        line(32, '1935', 0, 2400), line(32, '2641', 2400),
      ],
    )

    expect(item(31).mail_searchable).toBe(true)
    expect(item(32)).toMatchObject({ mail_searchable: true, portal: { vendor: 'Microsoft 365' } })
  })
  // crm#1584: a migrated payment names its invoice verifikat only in the text,
  // and the invoice PDF is already on it. A mail search finds the same PDF.
  it('hands over the invoice already on the verifikat a payment names, instead of a mail search', async () => {
    mockFetchCandidateTransactions.mockResolvedValue([])
    const rows = [
      {
        journal_entry_id: 'je-pay',
        voucher_series: 'V',
        voucher_number: 27,
        entry_date: '2026-01-26',
        description: 'Leverantörsfaktura #1001 betald till Konsultbolaget AB (V299)',
        source_type: 'import',
        gross_amount: 45475,
      },
    ]
    const supabase = mockSupabase(
      {
        ...fixture(),
        pending_operations: [],
        supplier_invoices: [],
        transactions: [],
        journal_entries: [
          {
            id: 'je-inv',
            company_id: 'co-1',
            status: 'posted',
            entry_date: '2025-12-28',
            voucher_series: 'V',
            voucher_number: 299,
            source_voucher_series: 'V',
            source_voucher_number: 299,
          },
        ],
        journal_entry_lines: [
          { journal_entry_id: 'je-pay', account_number: '2440', debit_amount: 45475, credit_amount: 0 },
          { journal_entry_id: 'je-pay', account_number: '1932', debit_amount: 0, credit_amount: 45475 },
          { journal_entry_id: 'je-inv', account_number: '2440', debit_amount: 0, credit_amount: 45475 },
          { journal_entry_id: 'je-inv', account_number: '6550', debit_amount: 45475, credit_amount: 0 },
        ],
        document_attachments: [
          { id: 'doc-v299', company_id: 'co-1', journal_entry_id: 'je-inv', is_current_version: true, created_at: '2026-10-31T21:12:00Z' },
        ],
      },
      { ok: true, total_count: 1, verifikat: rows },
    )

    const { items } = await resolveAgentWorklist(supabase, 'co-1')

    expect(items[0]).toMatchObject({
      journal_entry_id: 'je-pay',
      mail_searchable: false,
      portal: null,
      next_step: 'Fakturan finns redan på V299 (2025-12-28): koppla en kopia av den till det här verifikatet.',
      underlag_on: { voucher: 'V299', journal_entry_id: 'je-inv', entry_date: '2025-12-28', document_id: 'doc-v299' },
    })
  })
})

describe('nextStepKind: imported verifikat (crm#1582)', () => {
  it('reads source_type import before any word or line', () => {
    expect(nextStepKind('ICA Kvantum Solna', [], undefined, 'import')).toBe('imported')
    expect(nextStepKind('Skatteverket skattekonto', [], [{ account_number: '1630', debit_amount: 100 }], 'import')).toBe('imported')
    expect(nextStepKind('ICA Kvantum Solna', [], undefined, 'bank_transaction')).toBe('kivra')
    expect(nextStepKind('ICA Kvantum Solna')).toBe('kivra')
  })

  it('names the same reason the waiver dialogs suggest, so the two cannot drift apart', () => {
    const sv = JSON.parse(readFileSync(join(process.cwd(), 'src/messages/sv.json'), 'utf8'))
    expect(sv.journal_list.no_doc_required_suggestion_archived_elsewhere).toBe(UNDERLAG_ARCHIVED_ELSEWHERE_REASON)
  })
})

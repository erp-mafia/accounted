import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchCreditNoteCreditUsed, outstandingWithCreditUsed } from '../credit-note-settlement'

// Sequential result queue: each awaited query takes the next result.
let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let calls: Array<{ table: string; method: string; args: unknown[] }>

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order', 'range']) {
        b[m] = vi.fn().mockImplementation((...args: unknown[]) => {
          calls.push({ table, method: m, args })
          return b
        })
      }
      b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
      return b
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  calls = []
  supabase = makeClient()
})

// A kreditfaktura issued on a paid invoice, booked on its own verifikat.
const creditNote = { id: 'cn', total: -40000, currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-cn' }

// The payment row link_invoice_to_voucher writes on the new invoice when the
// credit note's verifikat is linked to it: dated on the verifikat's date.
function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    invoice_id: 'inv-new',
    journal_entry_id: 'je-cn',
    amount: 40000,
    currency: 'SEK',
    payment_exchange_rate: null,
    payment_date: '2026-09-01',
    invoice: { invoice_date: '2026-09-05' },
    ...overrides,
  }
}

describe('fetchCreditNoteCreditUsed', () => {
  it('makes no query when no row is a credit note with a verifikat', async () => {
    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [
      { id: 'inv-1', total: 1000, journal_entry_id: 'je-1' },
      { id: 'cn-unbooked', total: -500, journal_entry_id: null },
    ])

    expect(used.size).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it("reads the credit a credit note's verifikat paid on another invoice (crm#1059)", async () => {
    results = [{ data: [link()], error: null }]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [
      creditNote,
      { id: 'inv-new', total: 50000, journal_entry_id: 'je-new' },
    ])

    expect(used.get('cn')).toBe(40000)
    expect(used.has('inv-new')).toBe(false)
    expect(supabase.from).toHaveBeenCalledWith('invoice_payments')
    expect(calls).toContainEqual({ table: 'invoice_payments', method: 'eq', args: ['company_id', 'company-1'] })
    expect(calls).toContainEqual({ table: 'invoice_payments', method: 'in', args: ['journal_entry_id', ['je-cn']] })
  })

  it('adds up every link, a verifikat linked to two invoices included, and ignores a row on the credit note itself', async () => {
    // The link refuses a second link to the same invoice only, so the same
    // verifikat can pay two invoices: both uses count.
    results = [
      {
        data: [
          link({ id: 'pay-1', invoice_id: 'inv-a' }),
          link({ id: 'pay-2', invoice_id: 'inv-b' }),
          link({ id: 'pay-3', invoice_id: 'cn', amount: 5000 }),
        ],
        error: null,
      },
    ]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [creditNote])

    expect(used.get('cn')).toBe(80000)
  })

  it('never reads more from one link than the credit note holds', async () => {
    // A kronor row against a yen credit note: 7 123.46 kr at the credit
    // note's rate is 100 000.06, conversion noise above its 100 000 credit.
    results = [{ data: [link({ amount: 7123.46, currency: 'SEK' })], error: null }]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [
      { id: 'cn', total: -100000, currency: 'JPY', exchange_rate: 0.07123456, journal_entry_id: 'je-cn' },
    ])

    expect(used.get('cn')).toBe(100000)
  })

  it('counts a set-off on an as-of date only once the invoice it paid exists', async () => {
    // The payment row is dated on the credit note's verifikat (09-01), but
    // the invoice it paid is dated 09-05: in between, 1510 still held the
    // credit.
    results = [{ data: [link()], error: null }]
    const before = await fetchCreditNoteCreditUsed(supabase, 'company-1', [creditNote], '2026-09-04')
    expect(before.size).toBe(0)

    resultIdx = 0
    const onTheDay = await fetchCreditNoteCreditUsed(supabase, 'company-1', [creditNote], '2026-09-05')
    expect(onTheDay.get('cn')).toBe(40000)
  })

  it('counts a set-off on an as-of date from the payment date when the invoice is older', async () => {
    results = [{ data: [link({ payment_date: '2026-09-10', invoice: { invoice_date: '2026-08-01' } })], error: null }]
    const before = await fetchCreditNoteCreditUsed(supabase, 'company-1', [creditNote], '2026-09-09')
    expect(before.size).toBe(0)

    resultIdx = 0
    const after = await fetchCreditNoteCreditUsed(supabase, 'company-1', [creditNote], '2026-09-10')
    expect(after.get('cn')).toBe(40000)
  })

  it('reads the kronor fallback for a foreign invoice as the whole credit', async () => {
    // link_invoice_to_voucher settles a foreign invoice from a plain-SEK
    // verifikat with all of its kronor, whatever the row amount says.
    results = [{ data: [link({ amount: 3500, currency: 'EUR', payment_exchange_rate: 11.428571 })], error: null }]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [creditNote])

    expect(used.get('cn')).toBe(40000)
  })

  it("converts kronor used from a foreign credit note at the credit note's rate", async () => {
    results = [{ data: [link({ amount: 5500, currency: 'SEK' })], error: null }]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [
      { id: 'cn', total: -1000, currency: 'EUR', exchange_rate: 11, journal_entry_id: 'je-cn' },
    ])

    expect(used.get('cn')).toBe(500)
  })

  it('leaves out a row in a third currency it cannot read', async () => {
    results = [{ data: [link({ amount: 900, currency: 'USD' })], error: null }]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [
      { id: 'cn', total: -1000, currency: 'EUR', exchange_rate: 11, journal_entry_id: 'je-cn' },
    ])

    expect(used.size).toBe(0)
  })

  it('attributes nothing when two credit notes share one verifikat', async () => {
    results = [{ data: [link({ journal_entry_id: 'je-shared' })], error: null }]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', [
      { id: 'cn-1', total: -30000, currency: 'SEK', journal_entry_id: 'je-shared' },
      { id: 'cn-2', total: -10000, currency: 'SEK', journal_entry_id: 'je-shared' },
    ])

    expect(used.size).toBe(0)
  })

  it('reads the verifikat in chunks', async () => {
    const notes = Array.from({ length: 101 }, (_, i) => ({
      id: `cn-${i}`,
      total: -100,
      currency: 'SEK',
      journal_entry_id: `je-${i}`,
    }))
    results = [
      { data: [], error: null },
      { data: [link({ journal_entry_id: 'je-100', amount: 100 })], error: null },
    ]

    const used = await fetchCreditNoteCreditUsed(supabase, 'company-1', notes)

    const inCalls = calls.filter((c) => c.method === 'in')
    expect(inCalls.map((c) => (c.args[1] as string[]).length)).toEqual([100, 1])
    expect(used.get('cn-100')).toBe(100)
  })

  it('throws when the payment rows cannot be read', async () => {
    results = [{ data: null, error: { message: 'boom' } }]

    await expect(fetchCreditNoteCreditUsed(supabase, 'company-1', [creditNote])).rejects.toThrow()
  })
})

describe('outstandingWithCreditUsed', () => {
  it('returns a row that used no credit untouched', () => {
    expect(outstandingWithCreditUsed(1234.565, undefined)).toBe(1234.565)
    expect(outstandingWithCreditUsed(-40000, 0)).toBe(-40000)
  })

  it('settles a credit note used in full at zero', () => {
    expect(outstandingWithCreditUsed(-40000, 40000)).toBe(0)
  })

  it('keeps the unused rest open (a partial use the link does not write today)', () => {
    expect(outstandingWithCreditUsed(-40000, 15000)).toBe(-25000)
  })

  it('shows a credit used twice as a positive amount instead of hiding it at zero', () => {
    expect(outstandingWithCreditUsed(-40000, 80000)).toBe(40000)
  })
})

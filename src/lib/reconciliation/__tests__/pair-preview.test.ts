import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { describeMatchPairs, PAIR_PREVIEW_MAX_PAIRS, PAIR_PREVIEW_MAX_ROWS } from '../pair-preview'

/**
 * crm#1147: a staged reconciliation_match showed the reviewer a pair count
 * and nothing about which rows go to which verifikat. describeMatchPairs
 * reads the facts behind the staged pairs once, at staging. Amounts are made
 * up.
 */

const COMPANY = 'company-1'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const TAX = uuid(1)
const FEE = uuid(2)
const PAYMENT = uuid(3)
const PAYROLL = uuid(100)
const CASH = uuid(900)

const skvRow = (id: string, date: string, text: string, belopp: number) => ({
  id,
  transaktionsdatum: date,
  transaktionstext: text,
  belopp_skatteverket: belopp,
})

const bankRow = (id: string, date: string, description: string | null, amount: number, extra: Record<string, unknown> = {}) => ({
  id,
  date,
  description,
  merchant_name: null,
  amount,
  currency: 'SEK',
  ...extra,
})

const entry = (id: string, voucher: number, date: string, description: string, lines: Array<[string, number, number]>) => ({
  id,
  voucher_series: 'A',
  voucher_number: voucher,
  entry_date: date,
  description,
  lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
})

/** Payment into the skattekonto and the debitering it paid, in one voucher: 1630 nets to 0. */
const PAYROLL_ENTRY = entry(PAYROLL, 412, '2026-09-14', 'Skattekonto september', [
  ['1630', 12225, 0],
  ['1630', 0, 12225],
  ['1930', 0, 12225],
  ['2710', 4521, 0],
  ['2731', 7704, 0],
])

describe('describeMatchPairs: skattekonto', () => {
  it('states the rows, the verifikat and what it holds on 1630 for an N:1 pair', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    // Read in the opposite order to the dates: the preview lists oldest first.
    enqueue({ data: [skvRow(FEE, '2026-09-16', 'Arbetsgivaravgift augusti 2026', -7704), skvRow(TAX, '2026-09-14', 'Avdragen skatt augusti 2026', -4521)] })
    enqueue({ data: [PAYROLL_ENTRY] })
    enqueue({ data: [{ id: PAYMENT, journal_entry_id: PAYROLL, belopp_skatteverket: 12225 }] })

    const preview = await describeMatchPairs(
      supabase as never,
      COMPANY,
      'skattekonto',
      [{ external_ids: [FEE, TAX], journal_entry_ids: [PAYROLL] }],
      { remainders: new Map([[PAYROLL, 0]]) },
    )

    expect(preview).toEqual({
      ledger_account: '1630',
      pair_details_omitted: 0,
      pair_details: [
        {
          rows: [
            { external_id: TAX, date: '2026-09-14', text: 'Avdragen skatt augusti 2026', amount: -4521 },
            { external_id: FEE, date: '2026-09-16', text: 'Arbetsgivaravgift augusti 2026', amount: -7704 },
          ],
          row_count: 2,
          rows_total: -12225,
          entries: [
            {
              journal_entry_id: PAYROLL,
              voucher_series: 'A',
              voucher_number: 412,
              entry_date: '2026-09-14',
              description: 'Skattekonto september',
              // Only the lines on 1630 count: 1930, 2710 and 2731 are other accounts.
              account_debit: 12225,
              account_credit: 12225,
            },
          ],
          already_linked_count: 1,
          already_linked_total: 12225,
          remainder_amount: 0,
        },
      ],
    })
    // Every read is scoped to the company: the service-role paths have no RLS.
    for (const table of ['skattekonto_transactions', 'journal_entries']) {
      for (const call of findCalls(table, 'eq')) expect(call).toEqual(['company_id', COMPANY])
    }
    expect(findCalls('skattekonto_transactions', 'in')).toEqual([['id', [FEE, TAX]], ['journal_entry_id', [PAYROLL]]])
  })

  it('carries the dry run\'s remainder, and says nothing about it when the dry run did not', async () => {
    const pairs = [{ external_ids: [TAX], journal_entry_ids: [PAYROLL], allow_remainder: true }]
    const reads = (enqueue: (r: { data: unknown }) => void) => {
      enqueue({ data: [skvRow(TAX, '2026-09-14', 'Avdragen skatt augusti 2026', -4521)] })
      enqueue({ data: [PAYROLL_ENTRY] })
      enqueue({ data: [] })
    }

    const withRemainder = createQueuedMockSupabase()
    reads(withRemainder.enqueue)
    const first = await describeMatchPairs(withRemainder.supabase as never, COMPANY, 'skattekonto', pairs, {
      remainders: new Map([[PAYROLL, 4521]]),
    })
    expect(first?.pair_details[0]).toMatchObject({ rows_total: -4521, remainder_amount: 4521 })
    expect(first?.pair_details[0].already_linked_count).toBeUndefined()

    const without = createQueuedMockSupabase()
    reads(without.enqueue)
    const second = await describeMatchPairs(without.supabase as never, COMPANY, 'skattekonto', pairs)
    expect(second?.pair_details[0]).not.toHaveProperty('remainder_amount')
  })

  it('never counts a row of the staged pairs as already linked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [skvRow(TAX, '2026-09-14', 'Avdragen skatt augusti 2026', -4521)] })
    enqueue({ data: [PAYROLL_ENTRY] })
    // Staged a second time after a first approval: the row now points at the verifikat.
    enqueue({ data: [{ id: TAX, journal_entry_id: PAYROLL, belopp_skatteverket: -4521 }] })

    const preview = await describeMatchPairs(supabase as never, COMPANY, 'skattekonto', [
      { external_ids: [TAX], journal_entry_ids: [PAYROLL] },
    ])
    expect(preview?.pair_details[0]).not.toHaveProperty('already_linked_count')
  })

  it('sums to the öre', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [skvRow(TAX, '2026-09-14', 'Kostnadsränta', -0.1), skvRow(FEE, '2026-09-14', 'Kostnadsränta', -0.2)] })
    enqueue({ data: [entry(PAYROLL, 7, '2026-09-14', 'Ränta', [['1630', 0, 0.1], ['1630', 0, 0.2], ['8423', 0.3, 0]])] })
    enqueue({ data: [] })

    const preview = await describeMatchPairs(supabase as never, COMPANY, 'skattekonto', [
      { external_ids: [TAX, FEE], journal_entry_ids: [PAYROLL] },
    ])
    // 0.1 + 0.2 is 0.30000000000000004 in binary; the preview states 0.3.
    expect(preview?.pair_details[0].rows_total).toBe(-0.3)
    expect(preview?.pair_details[0].entries[0]).toMatchObject({ account_debit: 0, account_credit: 0.3 })
  })

  it('lists at most 20 rows of a pair, with the count and the sum of all of them', async () => {
    const ids = Array.from({ length: PAIR_PREVIEW_MAX_ROWS + 5 }, (_, i) => uuid(200 + i))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ids.map((id, i) => skvRow(id, `2026-09-${String(i + 1).padStart(2, '0')}`, `Rad ${i + 1}`, -100)) })
    enqueue({ data: [entry(PAYROLL, 9, '2026-09-30', 'Samlingsverifikat', [['1630', 0, 2500]])] })
    enqueue({ data: [] })

    const preview = await describeMatchPairs(supabase as never, COMPANY, 'skattekonto', [
      { external_ids: ids, journal_entry_ids: [PAYROLL] },
    ])
    const [pair] = preview?.pair_details ?? []
    expect(pair.rows).toHaveLength(PAIR_PREVIEW_MAX_ROWS)
    expect(pair.rows[0].date).toBe('2026-09-01')
    expect(pair.row_count).toBe(25)
    expect(pair.rows_total).toBe(-2500)
  })

  it('describes the first 50 pairs and counts the rest', async () => {
    const total = PAIR_PREVIEW_MAX_PAIRS + 10
    const pairs = Array.from({ length: total }, (_, i) => ({
      external_ids: [uuid(1000 + i)],
      journal_entry_ids: [uuid(5000 + i)],
    }))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const described = pairs.slice(0, PAIR_PREVIEW_MAX_PAIRS)
    enqueue({ data: described.map((p) => skvRow(p.external_ids[0], '2026-09-14', 'Kostnadsränta', -1)) })
    enqueue({ data: described.map((p, i) => entry(p.journal_entry_ids[0], i + 1, '2026-09-14', 'Ränta', [['1630', 0, 1]])) })
    enqueue({ data: [] })

    const preview = await describeMatchPairs(supabase as never, COMPANY, 'skattekonto', pairs)
    expect(preview?.pair_details).toHaveLength(PAIR_PREVIEW_MAX_PAIRS)
    expect(preview?.pair_details_omitted).toBe(10)
    // The pairs left out are not read either.
    expect((findCalls('journal_entries', 'in')[0][1] as string[]).length).toBe(PAIR_PREVIEW_MAX_PAIRS)
  })
})

describe('describeMatchPairs: bank', () => {
  const KEY = `bank:${CASH}`
  const TX = uuid(11)
  const TX2 = uuid(12)
  const V1 = uuid(101)
  const V2 = uuid(102)

  it('reads the account\'s own ledger account and states no remainder', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1940' } })
    enqueue({ data: [bankRow(TX, '2026-09-02', 'Swish inbetalning', 500), bankRow(TX2, '2026-09-01', null, 250, { merchant_name: 'Kund AB' })] })
    enqueue({ data: [entry(V1, 31, '2026-09-02', 'Dagskassa', [['1940', 750, 0], ['1930', 99, 0], ['3001', 0, 849]])] })

    // The staging tool passes its remainder map for every account kind; a
    // bank pair links row by row and has no remainder to state.
    const preview = await describeMatchPairs(
      supabase as never,
      COMPANY,
      KEY,
      [{ external_ids: [TX, TX2], journal_entry_ids: [V1] }],
      { remainders: new Map([[V1, 0]]) },
    )

    expect(preview?.ledger_account).toBe('1940')
    expect(preview?.pair_details[0]).toEqual({
      rows: [
        { external_id: TX2, date: '2026-09-01', text: 'Kund AB', amount: 250 },
        { external_id: TX, date: '2026-09-02', text: 'Swish inbetalning', amount: 500 },
      ],
      row_count: 2,
      rows_total: 750,
      entries: [
        {
          journal_entry_id: V1,
          voucher_series: 'A',
          voucher_number: 31,
          entry_date: '2026-09-02',
          description: 'Dagskassa',
          account_debit: 750,
          account_credit: 0,
        },
      ],
    })
    expect(findCalls('cash_accounts', 'eq')).toEqual([['company_id', COMPANY], ['id', CASH]])
    // No "already linked" read on a bank account: that is skattekonto's rule.
    expect(findCalls('skattekonto_transactions', 'in')).toEqual([])
  })

  it('shows the slice per verifikat for one row split over several', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    enqueue({ data: [bankRow(TX, '2026-09-02', 'Leverantörsbetalning', -800)] })
    enqueue({
      data: [
        entry(V1, 40, '2026-09-01', 'Faktura 1', [['1930', 0, 500], ['2440', 500, 0]]),
        entry(V2, 41, '2026-09-01', 'Faktura 2', [['1930', 0, 300], ['2440', 300, 0]]),
      ],
    })

    const preview = await describeMatchPairs(supabase as never, COMPANY, KEY, [
      {
        external_ids: [TX],
        journal_entry_ids: [V1, V2],
        allocations: [
          { journal_entry_id: V1, amount: -500 },
          { journal_entry_id: V2, amount: -300 },
        ],
      },
    ])
    expect(preview?.pair_details[0].entries.map((e) => [e.voucher_number, e.allocated_amount, e.account_credit])).toEqual([
      [40, -500, 500],
      [41, -300, 300],
    ])
  })

  it('names another currency, and gives no sum for rows in several', async () => {
    const eur = createQueuedMockSupabase()
    eur.enqueue({ data: { ledger_account: '1932' } })
    eur.enqueue({ data: [bankRow(TX, '2026-09-02', 'Payment', 100, { currency: 'EUR' })] })
    eur.enqueue({ data: [entry(V1, 50, '2026-09-02', 'EUR-betalning', [['1932', 1130, 0]])] })
    const one = await describeMatchPairs(eur.supabase as never, COMPANY, KEY, [{ external_ids: [TX], journal_entry_ids: [V1] }])
    expect(one?.pair_details[0]).toMatchObject({
      rows: [{ external_id: TX, amount: 100, currency: 'EUR' }],
      rows_total: 100,
      rows_currency: 'EUR',
    })

    const mixed = createQueuedMockSupabase()
    mixed.enqueue({ data: { ledger_account: '1932' } })
    mixed.enqueue({ data: [bankRow(TX, '2026-09-02', 'Payment', 100, { currency: 'EUR' }), bankRow(TX2, '2026-09-02', 'Betalning', 100)] })
    mixed.enqueue({ data: [entry(V1, 50, '2026-09-02', 'Betalning', [['1932', 1230, 0]])] })
    const two = await describeMatchPairs(mixed.supabase as never, COMPANY, KEY, [
      { external_ids: [TX, TX2], journal_entry_ids: [V1] },
    ])
    expect(two?.pair_details[0].rows_total).toBeNull()
    expect(two?.pair_details[0]).not.toHaveProperty('rows_currency')
  })
})

describe('describeMatchPairs: nothing to describe', () => {
  const PAIR = [{ external_ids: [TAX], journal_entry_ids: [PAYROLL] }]

  it('returns null for an account without outside rows, and makes no read', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await describeMatchPairs(supabase as never, COMPANY, 'manual:2440', PAIR)).toBeNull()
    expect(await describeMatchPairs(supabase as never, COMPANY, 'not-a-key', PAIR)).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns null when every pair is verifikat settled against each other', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(
      await describeMatchPairs(supabase as never, COMPANY, `bank:${CASH}`, [
        { external_ids: [], journal_entry_ids: [PAYROLL, uuid(101)] },
      ]),
    ).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns null, never half a pair, when a row or a verifikat cannot be read', async () => {
    const missingRow = createQueuedMockSupabase()
    missingRow.enqueue({ data: [] })
    missingRow.enqueue({ data: [PAYROLL_ENTRY] })
    missingRow.enqueue({ data: [] })
    expect(await describeMatchPairs(missingRow.supabase as never, COMPANY, 'skattekonto', PAIR)).toBeNull()

    const missingEntry = createQueuedMockSupabase()
    missingEntry.enqueue({ data: [skvRow(TAX, '2026-09-14', 'Avdragen skatt augusti 2026', -4521)] })
    missingEntry.enqueue({ data: [] })
    missingEntry.enqueue({ data: [] })
    expect(await describeMatchPairs(missingEntry.supabase as never, COMPANY, 'skattekonto', PAIR)).toBeNull()
  })

  it('returns null for an id that is no uuid, before any read', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(
      await describeMatchPairs(supabase as never, COMPANY, 'skattekonto', [
        { external_ids: ['row-1'], journal_entry_ids: [PAYROLL] },
      ]),
    ).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns null when the bank account is not the company\'s', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await describeMatchPairs(supabase as never, COMPANY, `bank:${CASH}`, PAIR)).toBeNull()
  })

  it('throws on a failed read, for the caller to stage without details', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'timeout' } })
    await expect(describeMatchPairs(supabase as never, COMPANY, 'skattekonto', PAIR)).rejects.toThrow()
  })
})

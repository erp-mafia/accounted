/**
 * The covering-samlingsverifikat half of the booking-time guard (issue #101,
 * crm#1386): a bank or feed row whose day a hand-entered (or migrated)
 * samlingsverifikat already holds is a possible double booking, and the guard
 * names that verifikat so the row is linked to it or ignored.
 *
 * The data layer is an in-memory table set that applies the filters the
 * detector sends (eq / in / gte / lte / gt / neq), so a test fails when the
 * query scope changes, not only when the arithmetic does. Fixtures are
 * synthetic.
 */
import { describe, it, expect } from 'vitest'
import {
  coveringVoucherSourceTypes,
  coveringVoucherWindowEnd,
  detectBookingDuplicate,
  detectCoveringVoucher,
  pickCoveringVoucher,
  type BookingTarget,
  type CoveringVoucherLine,
} from '../booking-duplicate-detection'

type Row = Record<string, unknown>
type Filter = [op: 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'gt', column: string, value: unknown]

const isIsoDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)

/** Numbers compare as numbers, ISO dates and other text as text. */
function compare(a: unknown, b: unknown): number {
  if (!isIsoDate(a) && !isIsoDate(b)) {
    const an = Number(a)
    const bn = Number(b)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  }
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

function matches(row: Row, [op, column, value]: Filter): boolean {
  const cell = row[column]
  switch (op) {
    case 'eq':
      return cell === value
    case 'neq':
      return cell !== value
    case 'in':
      return (value as unknown[]).includes(cell)
    case 'gte':
      return cell != null && compare(cell, value) >= 0
    case 'lte':
      return cell != null && compare(cell, value) <= 0
    case 'gt':
      return cell != null && compare(cell, value) > 0
  }
}

/** In-memory tables behind a PostgREST-shaped builder; records every query. */
function makeDb(tables: Record<string, Row[]>, opts: { failTables?: string[] } = {}) {
  const queries: { table: string; filters: Filter[] }[] = []
  const from = (table: string) => {
    const filters: Filter[] = []
    queries.push({ table, filters })
    let range: [number, number] | null = null
    let limit: number | null = null
    const run = () => {
      if (opts.failTables?.includes(table)) return { data: null, error: { message: 'boom' } }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => matches(r, f)))
      if (limit !== null) rows = rows.slice(0, limit)
      if (range) rows = rows.slice(range[0], range[1] + 1)
      return { data: rows, error: null }
    }
    const chain: Record<string, unknown> = {}
    const push = (op: Filter[0]) => (column: string, value: unknown) => {
      filters.push([op, column, value])
      return chain
    }
    Object.assign(chain, {
      select: () => chain,
      eq: push('eq'),
      neq: push('neq'),
      in: push('in'),
      gte: push('gte'),
      lte: push('lte'),
      gt: push('gt'),
      not: () => chain,
      is: () => chain,
      order: () => chain,
      limit: (n: number) => {
        limit = n
        return chain
      },
      range: (a: number, b: number) => {
        range = [a, b]
        return chain
      },
      maybeSingle: () => {
        const r = run()
        return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error })
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    })
    return chain
  }
  return { client: { from } as never, queries }
}

const COMPANY = 'co-1'
const STRIPE_CA = 'ca-stripe'
const BANK_CA = 'ca-bank'

const cashAccounts: Row[] = [
  { id: STRIPE_CA, company_id: COMPANY, ledger_account: '1686' },
  { id: BANK_CA, company_id: COMPANY, ledger_account: '1930' },
]

function entry(over: Row): Row {
  return {
    company_id: COMPANY,
    status: 'posted',
    source_type: 'manual',
    description: 'Stripe försäljning 2026-10-01 - 2026-10-17 (samlingsverifikat)',
    voucher_series: 'A',
    voucher_number: 13,
    ...over,
  }
}

function line(id: string, journal_entry_id: string, account_number: string, debit_amount: number, credit_amount = 0): Row {
  return { id, journal_entry_id, account_number, debit_amount, credit_amount }
}

/** A Stripe sale row of 49 kr on 8 October, not yet booked. */
function stripeRow(over: Partial<BookingTarget> = {}): BookingTarget {
  return { id: 'tx-new', date: '2026-10-08', amount: 49, currency: 'SEK', cash_account_id: STRIPE_CA, ...over }
}

/** Two 49 kr rows already linked by pointer to A13 (held 98 of 2 785). */
const heldRows: Row[] = [
  { id: 'tx-held-1', company_id: COMPANY, journal_entry_id: 'je-a13', amount: 49, currency: 'SEK', cash_account_id: STRIPE_CA, date: '2026-10-17' },
  { id: 'tx-held-2', company_id: COMPANY, journal_entry_id: 'je-a13', amount: 49, currency: 'SEK', cash_account_id: STRIPE_CA, date: '2026-10-17' },
]

function a13Db(extra: Partial<Record<string, Row[]>> = {}, opts: { failTables?: string[] } = {}) {
  return makeDb(
    {
      cash_accounts: cashAccounts,
      journal_entries: [entry({ id: 'je-a13', entry_date: '2026-10-17' })],
      journal_entry_lines: [line('l1', 'je-a13', '1686', 2785), line('l2', 'je-a13', '3001', 0, 2228), line('l3', 'je-a13', '2611', 0, 557)],
      transactions: heldRows,
      transaction_voucher_links: [],
      ...extra,
    },
    opts,
  )
}

describe('coveringVoucherWindowEnd', () => {
  it('keeps a bank account to the row day itself (gemensam verifikation is one day)', () => {
    expect(coveringVoucherWindowEnd('2026-10-08', '1930')).toBe('2026-10-08')
    expect(coveringVoucherWindowEnd('2026-10-08', '1940')).toBe('2026-10-08')
  })

  it('reaches the end of the next month on a payment provider account', () => {
    expect(coveringVoucherWindowEnd('2026-08-15', '1686')).toBe('2026-09-30')
    expect(coveringVoucherWindowEnd('2026-01-31', '1686')).toBe('2026-02-28')
    expect(coveringVoucherWindowEnd('2026-12-10', '1686')).toBe('2027-01-31')
  })

  it('answers null for a malformed date', () => {
    expect(coveringVoucherWindowEnd('2026-10', '1686')).toBeNull()
  })
})

describe('coveringVoucherSourceTypes', () => {
  it('counts only hand-entered vouchers on a bank account, and migrated period summaries on 1686 too', () => {
    expect(coveringVoucherSourceTypes('1930')).toEqual(['manual'])
    expect(coveringVoucherSourceTypes('1686')).toEqual(['manual', 'import'])
  })
})

describe('pickCoveringVoucher', () => {
  const je = (id: string, entry_date: string): CoveringVoucherLine['journal_entry'] => ({
    id,
    entry_date,
    description: null,
    voucher_series: 'A',
    voucher_number: 1,
  })
  const l = (entryId: string, date: string, debit: number, credit = 0): CoveringVoucherLine => ({
    debit_amount: debit,
    credit_amount: credit,
    journal_entry: je(entryId, date),
  })

  it('picks a verifikat with room for the row and reports booked, held and unlinked', () => {
    const pick = pickCoveringVoucher({ amountSek: 49 }, [l('je-1', '2026-10-17', 2785)], new Map([['je-1', 98]]))
    expect(pick?.entry.id).toBe('je-1')
    expect(pick?.facts).toEqual({ booked: 2785, held: 98, unlinked: 2687 })
  })

  it('skips a verifikat whose part is fully held by linked rows (the bulk-booked day)', () => {
    // Prod shape: each day's verifikat holds exactly the rows bulk-linked to
    // it, and the other rows of that day are other sales.
    const pick = pickCoveringVoucher({ amountSek: 47.39 }, [l('je-1', '2026-08-05', 426.76)], new Map([['je-1', 426.76]]))
    expect(pick).toBeNull()
  })

  it('skips a verifikat that books nothing in the row direction', () => {
    expect(pickCoveringVoucher({ amountSek: 49 }, [l('je-fees', '2026-10-17', 0, 256.15)], new Map())).toBeNull()
    expect(pickCoveringVoucher({ amountSek: -2.54 }, [l('je-fees', '2026-10-17', 0, 256.15)], new Map())?.entry.id).toBe('je-fees')
  })

  it('refuses a row larger than the unlinked part, within the one-öre slack', () => {
    expect(pickCoveringVoucher({ amountSek: 100 }, [l('je-1', '2026-10-17', 120)], new Map([['je-1', 30]]))).toBeNull()
    expect(pickCoveringVoucher({ amountSek: 90.01 }, [l('je-1', '2026-10-17', 120)], new Map([['je-1', 30]]))).not.toBeNull()
  })

  it('takes the earliest verifikat, then the lowest id, so a force re-detect is stable', () => {
    const lines = [l('je-b', '2026-10-31', 500), l('je-c', '2026-10-17', 500), l('je-a', '2026-10-17', 500)]
    expect(pickCoveringVoucher({ amountSek: 49 }, lines, new Map())?.entry.id).toBe('je-a')
  })

  it('sums several lines of one verifikat on the account', () => {
    const pick = pickCoveringVoucher({ amountSek: 150 }, [l('je-1', '2026-10-17', 100), l('je-1', '2026-10-17', 100)], new Map())
    expect(pick?.facts.booked).toBe(200)
  })
})

describe('detectCoveringVoucher', () => {
  it('names the samlingsverifikat that holds a Stripe row day and still has room (the crm#1386 shape)', async () => {
    const { client, queries } = a13Db()
    const candidate = await detectCoveringVoucher(client, COMPANY, stripeRow())

    expect(candidate).toMatchObject({
      transaction_id: null,
      journal_entry_id: 'je-a13',
      voucher_label: 'A13',
      entry_date: '2026-10-17',
      amount: 2785,
      account_number: '1686',
      amount_verified: true,
      covering: { booked: 2785, held: 98, unlinked: 2687 },
    })
    // Scope: the company's posted hand-entered or migrated vouchers from the
    // row day to the end of the next month, legs on 1686 in the row direction.
    const entries = queries.find((q) => q.table === 'journal_entries')!.filters
    expect(entries).toContainEqual(['eq', 'company_id', COMPANY])
    expect(entries).toContainEqual(['eq', 'status', 'posted'])
    expect(entries).toContainEqual(['in', 'source_type', ['manual', 'import']])
    expect(entries).toContainEqual(['gte', 'entry_date', '2026-10-08'])
    expect(entries).toContainEqual(['lte', 'entry_date', '2026-11-30'])
    const lines = queries.find((q) => q.table === 'journal_entry_lines')!.filters
    expect(lines).toContainEqual(['eq', 'account_number', '1686'])
    expect(lines).toContainEqual(['gt', 'debit_amount', 0])
  })

  it('counts a bank_line slice as held, like a pointer', async () => {
    const { client } = a13Db({
      transactions: [],
      transaction_voucher_links: [
        {
          company_id: COMPANY,
          role: 'bank_line',
          journal_entry_id: 'je-a13',
          transaction_id: 'tx-bulk',
          allocated_amount: 2700,
          transactions: { amount: 2700, currency: 'SEK', cash_account_id: STRIPE_CA },
        },
      ],
    })
    // 2 785 - 2 700 = 85 left: a 49 kr row fits, a 90 kr row does not.
    expect((await detectCoveringVoucher(client, COMPANY, stripeRow()))?.covering?.unlinked).toBe(85)
    expect(await detectCoveringVoucher(client, COMPANY, stripeRow({ amount: 90 }))).toBeNull()
  })

  it('stays silent when every krona of the samlingsverifikat is held by linked rows', async () => {
    const full = Array.from({ length: 5 }, (_, i) => ({
      id: `tx-h${i}`,
      company_id: COMPANY,
      journal_entry_id: 'je-a13',
      amount: 557,
      currency: 'SEK',
      cash_account_id: STRIPE_CA,
      date: '2026-10-10',
    }))
    const { client } = a13Db({ transactions: full })
    expect(await detectCoveringVoucher(client, COMPANY, stripeRow())).toBeNull()
  })

  it('ignores a voucher dated before the row day (the row is not in a period already closed off)', async () => {
    const { client } = a13Db()
    expect(await detectCoveringVoucher(client, COMPANY, stripeRow({ date: '2026-10-18' }))).toBeNull()
  })

  it('ignores a bank_transaction verifikat: only vouchers entered outside the feed hold a period', async () => {
    const { client } = a13Db({ journal_entries: [entry({ id: 'je-a13', entry_date: '2026-10-17', source_type: 'bank_transaction' })] })
    expect(await detectCoveringVoucher(client, COMPANY, stripeRow())).toBeNull()
  })

  it('on a bank account looks at the row day only, and at hand-entered vouchers only', async () => {
    const tables = {
      cash_accounts: cashAccounts,
      journal_entries: [
        entry({ id: 'je-day', entry_date: '2026-09-20', description: 'Samlingsverifikation 2026-09-20 Swish' }),
        entry({ id: 'je-later', entry_date: '2026-09-21', description: 'Leverantörsbetalning' }),
      ],
      journal_entry_lines: [line('l1', 'je-day', '1930', 600), line('l2', 'je-later', '1930', 5000)],
      transactions: [],
      transaction_voucher_links: [],
    }
    const swish: BookingTarget = { id: 'tx-swish', date: '2026-09-20', amount: 50, currency: 'SEK', cash_account_id: BANK_CA }
    const { client, queries } = makeDb(tables)
    expect((await detectCoveringVoucher(client, COMPANY, swish))?.journal_entry_id).toBe('je-day')
    const entries = queries.find((q) => q.table === 'journal_entries')!.filters
    expect(entries).toContainEqual(['in', 'source_type', ['manual']])
    expect(entries).toContainEqual(['lte', 'entry_date', '2026-09-20'])
    // The day after holds nothing: the later hand voucher is another payment.
    expect(await detectCoveringVoucher(makeDb(tables).client, COMPANY, { ...swish, date: '2026-09-19' })).toBeNull()
  })

  it('leaves out the vouchers of the same bulk run', async () => {
    const { client } = a13Db()
    expect(await detectCoveringVoucher(client, COMPANY, stripeRow(), { excludeJournalEntryIds: ['je-a13'] })).toBeNull()
  })

  it('stays silent without a settlement account, for a foreign row, and for a zero row (no queries)', async () => {
    const noAccount = a13Db()
    expect(await detectCoveringVoucher(noAccount.client, COMPANY, stripeRow({ cash_account_id: null }))).toBeNull()
    expect(noAccount.queries).toHaveLength(0)

    const eur = a13Db()
    expect(await detectCoveringVoucher(eur.client, COMPANY, stripeRow({ currency: 'EUR' }))).toBeNull()
    expect(eur.queries).toHaveLength(0)

    const zero = a13Db()
    expect(await detectCoveringVoucher(zero.client, COMPANY, stripeRow({ amount: 0 }))).toBeNull()
    expect(zero.queries).toHaveLength(0)
  })

  it('fails open when the linked rows cannot be read: a failed check never blocks a booking', async () => {
    const { client } = a13Db({}, { failTables: ['transaction_voucher_links'] })
    expect(await detectCoveringVoucher(client, COMPANY, stripeRow())).toBeNull()
  })

  it('uses a settlement account the caller already resolved', async () => {
    const { client, queries } = a13Db()
    const candidate = await detectCoveringVoucher(client, COMPANY, stripeRow({ cash_account_id: STRIPE_CA, settlement_account: '1686' }))
    expect(candidate?.journal_entry_id).toBe('je-a13')
    expect(queries.some((q) => q.table === 'cash_accounts')).toBe(false)
  })
})

describe('detectBookingDuplicate falls through to the covering samlingsverifikat', () => {
  it('names it when no sibling row and no same-amount voucher exist', async () => {
    const { client } = a13Db()
    const candidate = await detectBookingDuplicate(client, COMPANY, stripeRow())
    expect(candidate?.journal_entry_id).toBe('je-a13')
    expect(candidate?.covering?.unlinked).toBe(2687)
  })

  it('still prefers a same-amount ledger twin, which is the stronger signal', async () => {
    const { client } = a13Db({
      journal_entries: [
        entry({ id: 'je-a13', entry_date: '2026-10-17' }),
        entry({ id: 'je-twin', entry_date: '2026-10-08', description: 'Stripe 49', voucher_number: 9 }),
      ],
      journal_entry_lines: [line('l1', 'je-a13', '1686', 2785), line('l9', 'je-twin', '1686', 49)],
    })
    const candidate = await detectBookingDuplicate(client, COMPANY, stripeRow())
    expect(candidate?.journal_entry_id).toBe('je-twin')
    expect(candidate?.covering).toBeUndefined()
  })
})

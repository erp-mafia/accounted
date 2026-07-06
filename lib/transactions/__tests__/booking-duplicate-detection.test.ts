/**
 * Tests for the booking-time duplicate guard.
 *
 * Detection queries `transactions` for same-date already-booked siblings, then
 * filters by öre + cash-account compatibility in JS, then resolves the voucher
 * label from `journal_entries`. The mock returns the rows each query yields.
 */
import { describe, it, expect } from 'vitest'
import {
  detectBookedDuplicateTransaction,
  detectLedgerDuplicateVoucher,
  detectBookingDuplicate,
} from '../booking-duplicate-detection'

type TxRow = {
  id: string
  date: string
  amount: number | string
  description: string | null
  cash_account_id: string | null
  journal_entry_id: string
}
type JeRow = { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }

function txChain(data: TxRow[]) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.not = () => c
  c.neq = () => c
  c.limit = () => Promise.resolve({ data, error: null })
  return c
}
function jeChain(data: JeRow | null) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.maybeSingle = () => Promise.resolve({ data, error: null })
  return c
}
function makeSupabase(txData: TxRow[], jeData: JeRow | null = { voucher_series: 'A', voucher_number: 142, entry_date: '2025-12-19' }) {
  return {
    from: (table: string) => (table === 'transactions' ? txChain(txData) : jeChain(jeData)),
  } as never
}

const COMPANY = 'co-1'
const sibling = (over: Partial<TxRow> = {}): TxRow => ({
  id: 'sib-1',
  date: '2025-12-19',
  amount: -1616,
  description: 'TELENOR SVERIGE AB',
  cash_account_id: null,
  journal_entry_id: 'je-1',
  ...over,
})

describe('detectBookedDuplicateTransaction', () => {
  it('returns null when no same-date booked sibling exists', async () => {
    const supabase = makeSupabase([])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('flags a same date+amount+account booked sibling with its voucher label', async () => {
    const supabase = makeSupabase([sibling()])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result).toEqual({
      transaction_id: 'sib-1',
      journal_entry_id: 'je-1',
      voucher_label: 'A142',
      entry_date: '2025-12-19',
      description: 'TELENOR SVERIGE AB',
      amount: -1616,
    })
  })

  it('does NOT flag a sibling on a different known cash account', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: 'acct-B',
    })
    expect(result).toBeNull()
  })

  it('flags when accounts are compatible via a null on either side', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('does NOT flag a sibling with a different amount', async () => {
    const supabase = makeSupabase([sibling({ amount: -1000 })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('matches a numeric-string amount from PostgREST against a JS number (öre)', async () => {
    const supabase = makeSupabase([sibling({ amount: '-1616.00' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('returns null for a zero-amount target without querying', async () => {
    const supabase = makeSupabase([sibling({ amount: 0 })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: 0, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('picks the lowest-id sibling deterministically (stable under force re-detect)', async () => {
    const supabase = makeSupabase([
      sibling({ id: 'sib-9' }),
      sibling({ id: 'sib-2' }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-2')
  })

  // ── Intra-batch exclusion (bulk-book false-positive fix) ────────────────
  it('excludes a same-batch sibling whose id is in excludeTransactionIds', async () => {
    const supabase = makeSupabase([sibling({ id: 'sib-batch' })])
    const result = await detectBookedDuplicateTransaction(
      supabase,
      COMPANY,
      { id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null },
      { excludeTransactionIds: ['sib-batch'] },
    )
    expect(result).toBeNull()
  })

  it('STILL flags a pre-existing sibling not in excludeTransactionIds (invariant preserved)', async () => {
    // 'sib-old' existed before the batch; only 'sib-batch' was booked this run.
    const supabase = makeSupabase([sibling({ id: 'sib-old' })])
    const result = await detectBookedDuplicateTransaction(
      supabase,
      COMPANY,
      { id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null },
      { excludeTransactionIds: ['sib-batch'] },
    )
    expect(result?.transaction_id).toBe('sib-old')
  })
})

// ── Ledger-only voucher guard (the orphan with no sibling transaction) ───────

type Jel = {
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  journal_entry: {
    id: string
    entry_date: string
    description: string | null
    voucher_series: string | null
    voucher_number: number | null
    status: string
    source_type: string | null
  }
}

/** A chain whose terminals all resolve to the SAME canned result for a table. */
function ledgerChain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.neq = () => c
  c.not = () => c
  c.gt = () => c
  c.gte = () => c
  c.lte = () => c
  c.limit = () => Promise.resolve(result)
  c.maybeSingle = () => Promise.resolve(result)
  c.single = () => Promise.resolve(result)
  c.in = () => Promise.resolve(result) // terminal for the link-exclusion lookups
  return c
}

function makeLedgerSupabase(opts: {
  ledgerAccount?: string | null
  lines?: Jel[]
  txLinks?: { journal_entry_id: string }[]
  payLinks?: { journal_entry_id: string }[]
  transactionRows?: TxRow[] // siblings for the orchestrator fall-through
}) {
  return {
    from: (table: string) => {
      switch (table) {
        case 'cash_accounts':
          return ledgerChain({
            data: opts.ledgerAccount != null ? { ledger_account: opts.ledgerAccount } : null,
            error: null,
          })
        case 'journal_entry_lines':
          return ledgerChain({ data: opts.lines ?? [], error: null })
        case 'invoice_payments':
          return ledgerChain({ data: opts.payLinks ?? [], error: null })
        case 'transactions':
          // Same table backs the sibling scan (.limit) and the link-exclusion
          // lookup (.in). The sibling scan returns transactionRows; the link
          // lookup returns txLinks. With a shape-only mock both share one canned
          // result, so tests that need a sibling set transactionRows and leave
          // txLinks empty (and vice versa).
          return ledgerChain({ data: opts.transactionRows ?? opts.txLinks ?? [], error: null })
        default:
          return ledgerChain({ data: null, error: null })
      }
    },
  } as never
}

const jel = (over: Partial<Jel> = {}): Jel => ({
  account_number: over.account_number ?? '1930',
  debit_amount: over.debit_amount ?? 98565,
  credit_amount: over.credit_amount ?? 0,
  journal_entry: {
    id: 'je-2',
    entry_date: '2026-03-30',
    description: 'Inbetalning kundfaktura 2026001',
    voucher_series: 'A',
    voucher_number: 2,
    status: 'posted',
    source_type: 'invoice_paid',
    ...over.journal_entry,
  },
})

describe('detectLedgerDuplicateVoucher', () => {
  it('flags an inbound receipt already booked as a 19xx debit voucher (no sibling tx)', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result).toEqual({
      transaction_id: null,
      journal_entry_id: 'je-2',
      voucher_label: 'A2',
      entry_date: '2026-03-30',
      description: 'Inbetalning kundfaktura 2026001',
      amount: 98565,
    })
  })

  it('flags an outbound payout already booked as a 19xx credit voucher (salary case)', async () => {
    const salaryLine = jel({
      debit_amount: 0,
      credit_amount: 16609,
      journal_entry: {
        id: 'je-3', entry_date: '2026-05-04', description: 'Lön 2026-05: Nettolön',
        voucher_series: 'A', voucher_number: 3, status: 'posted', source_type: 'salary',
      },
    })
    const supabase = makeLedgerSupabase({ lines: [salaryLine] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-05-04', amount: -16609, cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-3')
    expect(result?.transaction_id).toBeNull()
    expect(result?.amount).toBe(16609)
  })

  it('does NOT flag an inbound receipt against a credit-only voucher (wrong direction)', async () => {
    // A 19xx CREDIT is a payout, not the receipt the inbound line is looking for.
    const supabase = makeLedgerSupabase({ lines: [jel({ debit_amount: 0, credit_amount: 98565 })] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('does NOT flag when the amount differs', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel({ debit_amount: 90000 })] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('excludes a voucher already linked to a transaction', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()], txLinks: [{ journal_entry_id: 'je-2' }] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('excludes a voucher already linked to an invoice payment', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()], payLinks: [{ journal_entry_id: 'je-2' }] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('ignores storno/correction vouchers (valid second vouchers, not duplicates)', async () => {
    const stornoLine = jel({ journal_entry: { ...jel().journal_entry, source_type: 'storno' } })
    const supabase = makeLedgerSupabase({ lines: [stornoLine] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('matches a numeric-string leg amount from PostgREST (öre)', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel({ debit_amount: '98565.00' })] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-2')
  })

  it('returns null for a zero-amount target without querying', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 0, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  // ── Intra-batch exclusion (bulk-book false-positive fix) ────────────────
  it('excludes a same-batch voucher whose journal_entry.id is in excludeJournalEntryIds', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] }) // jel() → journal_entry.id 'je-2'
    const result = await detectLedgerDuplicateVoucher(
      supabase,
      COMPANY,
      { id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null },
      { excludeJournalEntryIds: ['je-2'] },
    )
    expect(result).toBeNull()
  })

  it('STILL flags a pre-existing voucher not in excludeJournalEntryIds (invariant preserved)', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(
      supabase,
      COMPANY,
      { id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null },
      { excludeJournalEntryIds: ['je-booked-this-batch'] },
    )
    expect(result?.journal_entry_id).toBe('je-2')
  })
})

describe('detectBookingDuplicate (orchestrator)', () => {
  it('returns the sibling transaction when one exists (voucher scan not needed)', async () => {
    const supabase = makeLedgerSupabase({ transactionRows: [sibling()] })
    const result = await detectBookingDuplicate(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('falls through to the ledger voucher when there is no sibling transaction', async () => {
    const supabase = makeLedgerSupabase({ transactionRows: [], lines: [jel()] })
    const result = await detectBookingDuplicate(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result?.transaction_id).toBeNull()
    expect(result?.journal_entry_id).toBe('je-2')
  })

  it('returns null when neither a sibling nor a voucher matches', async () => {
    const supabase = makeLedgerSupabase({ transactionRows: [], lines: [] })
    const result = await detectBookingDuplicate(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('propagates exclusions to BOTH the sibling scan and the ledger scan', async () => {
    // A matching sibling AND a matching ledger voucher exist, but both belong to
    // this same batch (excluded) → the orchestrator must report no duplicate.
    const supabase = makeLedgerSupabase({
      transactionRows: [sibling({ id: 'sib-batch', amount: 98565, journal_entry_id: 'je-sib' })],
      lines: [jel()], // journal_entry.id 'je-2'
    })
    const result = await detectBookingDuplicate(
      supabase,
      COMPANY,
      { id: 'self', date: '2026-03-26', amount: 98565, cash_account_id: null },
      { excludeTransactionIds: ['sib-batch'], excludeJournalEntryIds: ['je-2'] },
    )
    expect(result).toBeNull()
  })
})

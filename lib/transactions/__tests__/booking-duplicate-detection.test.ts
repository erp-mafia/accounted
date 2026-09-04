/**
 * Tests for the booking-time duplicate guard.
 *
 * Detection queries `transactions` for same-date already-booked siblings, then
 * filters by öre + cash-account compatibility in JS, then resolves the voucher
 * label from `journal_entries`. The mock returns the rows each query yields.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  detectBookedDuplicateTransaction,
  detectLedgerDuplicateVoucher,
  detectBookingDuplicate,
} from '../booking-duplicate-detection'

type TxRow = {
  id: string
  date: string
  amount: number | string
  /** Absent in most fixtures: the detector normalises a missing/null label to SEK. */
  currency?: string | null
  /** The sibling's own FX fields: the source of its reported SEK figure. */
  amount_sek?: number | string | null
  exchange_rate?: number | string | null
  description: string | null
  cash_account_id: string | null
  /** NULL = no 1:1 anchor; booked-ness may still come from links/payments. */
  journal_entry_id: string | null
}
type JeRow = { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }

/** Anchor rows for the is_transaction_booked resolution (batch-fetched). */
type SiblingAnchors = {
  voucherLinks?: { transaction_id: string; journal_entry_id: string }[]
  invoicePayments?: { transaction_id: string | null; journal_entry_id: string | null }[]
  supplierPayments?: { transaction_id: string | null; journal_entry_id: string | null }[]
}

function txChain(data: TxRow[]) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.not = () => c
  c.neq = () => c
  c.gte = () => c
  c.lte = () => c
  c.order = () => c
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
/** Chain for the anchor lookups, terminal on `.in()`. */
function anchorChain(data: unknown[]) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.in = () => Promise.resolve({ data, error: null })
  return c
}
function makeSupabase(
  txData: TxRow[],
  jeData: JeRow | null = { voucher_series: 'A', voucher_number: 142, entry_date: '2025-12-19' },
  anchors: SiblingAnchors = {},
) {
  return {
    from: (table: string) => {
      switch (table) {
        case 'transactions':
          return txChain(txData)
        case 'transaction_voucher_links':
          return anchorChain(anchors.voucherLinks ?? [])
        case 'invoice_payments':
          return anchorChain(anchors.invoicePayments ?? [])
        case 'supplier_invoice_payments':
          return anchorChain(anchors.supplierPayments ?? [])
        default:
          return jeChain(jeData)
      }
    },
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
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('flags a same date+amount+account booked sibling with its voucher label', async () => {
    const supabase = makeSupabase([sibling()])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toEqual({
      transaction_id: 'sib-1',
      currency: null,
      amount_in_currency: null,
      journal_entry_id: 'je-1',
      voucher_label: 'A142',
      entry_date: '2025-12-19',
      description: 'TELENOR SVERIGE AB',
      amount: -1616,
      account_number: null,
      amount_verified: true,
      unverified_reason: null,
    })
  })

  it('does NOT flag a sibling on a different known cash account', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: 'acct-B',
    })
    expect(result).toBeNull()
  })

  it('flags when accounts are compatible via a null on either side', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('does NOT flag a sibling with a different amount', async () => {
    const supabase = makeSupabase([sibling({ amount: -1000 })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('matches a numeric-string amount from PostgREST against a JS number (öre)', async () => {
    const supabase = makeSupabase([sibling({ amount: '-1616.00' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('returns null for a zero-amount target without querying', async () => {
    const supabase = makeSupabase([sibling({ amount: 0 })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: 0, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('picks the lowest-id sibling deterministically (stable under force re-detect)', async () => {
    const supabase = makeSupabase([
      sibling({ id: 'sib-9' }),
      sibling({ id: 'sib-2' }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-2')
  })

  // ── Date window (a duplicate import often drifts: bokföringsdag vs valutadag) ──
  it('flags a booked sibling one day earlier (window recall, gap G1)', async () => {
    const supabase = makeSupabase([sibling({ date: '2025-12-18' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('does NOT flag a booked sibling outside the ±3 day window', async () => {
    // 5 days out: repeated monthly/weekly charges must not warn.
    const supabase = makeSupabase([sibling({ date: '2025-12-14' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('prefers the exact-date sibling over a drifted one regardless of id order', async () => {
    // The drifted sibling carries the LOWER id: a bare lowest-id pick would
    // choose it, so this pins the date-distance-first ranking (force=true is
    // bound to the reviewed candidate and re-detection must return the same
    // one).
    const supabase = makeSupabase([
      sibling({ id: 'sib-0-drifted', date: '2025-12-17' }),
      sibling({ id: 'sib-9-exact', date: '2025-12-19' }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-9-exact')
  })

  // ── Booked-ness via is_transaction_booked semantics (gap G2) ────────────
  it('detects a bulk-booked sibling anchored only via transaction_voucher_links', async () => {
    // journal_entry_id NULL is the documented shape for N-tx-to-1-JE bulk
    // bookings (lib/transactions/is-booked.ts); the old bare-column filter
    // made these twins invisible.
    const supabase = makeSupabase(
      [sibling({ journal_entry_id: null })],
      { voucher_series: 'A', voucher_number: 142, entry_date: '2025-12-19' },
      { voucherLinks: [{ transaction_id: 'sib-1', journal_entry_id: 'je-bulk' }] },
    )
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
    expect(result?.journal_entry_id).toBe('je-bulk')
  })

  it('detects a multi-allocated sibling anchored only via invoice_payments', async () => {
    const supabase = makeSupabase(
      [sibling({ journal_entry_id: null })],
      { voucher_series: 'A', voucher_number: 142, entry_date: '2025-12-19' },
      { invoicePayments: [{ transaction_id: 'sib-1', journal_entry_id: 'je-alloc' }] },
    )
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
    expect(result?.journal_entry_id).toBe('je-alloc')
  })

  it('does NOT flag an unbooked sibling (no anchor in any of the three sources)', async () => {
    const supabase = makeSupabase([sibling({ journal_entry_id: null })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('excludes a voucher-link-anchored sibling whose entry is in excludeJournalEntryIds', async () => {
    // A sibling anchored to a JE minted THIS batch is the batch's own fresh
    // booking, mirroring the ledger half's entry-id exclusion.
    const supabase = makeSupabase(
      [sibling({ journal_entry_id: null })],
      { voucher_series: 'A', voucher_number: 142, entry_date: '2025-12-19' },
      { voucherLinks: [{ transaction_id: 'sib-1', journal_entry_id: 'je-batch' }] },
    )
    const result = await detectBookedDuplicateTransaction(
      supabase,
      COMPANY,
      { id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null },
      { excludeJournalEntryIds: ['je-batch'] },
    )
    expect(result).toBeNull()
  })

  // ── Intra-batch exclusion (bulk-book false-positive fix) ────────────────
  it('excludes a same-batch sibling whose id is in excludeTransactionIds', async () => {
    const supabase = makeSupabase([sibling({ id: 'sib-batch' })])
    const result = await detectBookedDuplicateTransaction(
      supabase,
      COMPANY,
      { id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null },
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
      { id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null },
      { excludeTransactionIds: ['sib-batch'] },
    )
    expect(result?.transaction_id).toBe('sib-old')
  })

  // ── Currency (transactions.amount is denominated in transactions.currency) ──
  it('flags a foreign sibling and reports ITS OWN SEK figure, never the raw EUR number', async () => {
    // The candidate's `amount` field is kr-labelled by every consumer
    // (formatCurrency's SEK default in DuplicateBookingDialog, "${amount} kr"
    // in the agent messages), so it must hold the sibling's SEK value, exactly
    // as the ledger branch reports the 19xx leg's SEK figure.
    const supabase = makeSupabase([
      sibling({ amount: -1000, currency: 'EUR', amount_sek: -11500, exchange_rate: 11.5 }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1000, currency: 'EUR',
      amount_sek: -11450, exchange_rate: 11.45, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
    // The SIBLING's stored SEK, not the raw -1000 and not the target's -11450.
    expect(result?.amount).toBe(-11500)
    expect(result?.amount_verified).toBe(true)
    expect(result?.unverified_reason).toBeNull()
    // Foreign context rides along so the UI can show the recognisable original.
    expect(result?.currency).toBe('EUR')
    expect(result?.amount_in_currency).toBe(-1000)
  })

  it('converts via the sibling exchange_rate when its amount_sek was never stored', async () => {
    const supabase = makeSupabase([
      sibling({ amount: -1000, currency: 'EUR', amount_sek: null, exchange_rate: 11.5 }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1000, currency: 'EUR',
      amount_sek: -11500, exchange_rate: 11.5, cash_account_id: null,
    })
    expect(result?.amount).toBe(-11500)
    expect(result?.amount_verified).toBe(true)
  })

  it('surfaces a rateless foreign sibling as unverified with NO kr figure', async () => {
    // THE dialog bug this module's contract exists to prevent: a 1 000 EUR
    // sibling without amount_sek/exchange_rate used to reach the dialog as
    // amount: -1000, which formatCurrency() prints as "-1 000,00 kr" for an
    // ~11 500 kr movement, on the exact screen whose only question is "is this
    // the same event?". The match itself is exact (same currency, same öre),
    // so the candidate is still surfaced: but with the honest foreign figure
    // and no fabricated kronor. Note the TARGET's own rate is present here and
    // must NOT be borrowed for the sibling.
    const supabase = makeSupabase([sibling({ amount: -1000, currency: 'EUR' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1000, currency: 'EUR',
      amount_sek: -11500, exchange_rate: 11.5, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
    expect(result?.amount).toBeNull()
    expect(result?.amount_verified).toBe(false)
    expect(result?.unverified_reason).toBe('transaction_missing_sek_value')
    expect(result?.currency).toBe('EUR')
    expect(result?.amount_in_currency).toBe(-1000)
  })

  it('does NOT flag a EUR line against a same-magnitude SEK sibling', async () => {
    // 100 EUR and 100 SEK on one day are two different affärshändelser. Before
    // the currency guard the raw öre keys collided and this false-positived.
    const supabase = makeSupabase([sibling({ amount: -100, currency: 'SEK' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -100, currency: 'EUR',
      amount_sek: -1150, exchange_rate: 11.5, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('does NOT flag a SEK line against a same-magnitude EUR sibling (mirror)', async () => {
    const supabase = makeSupabase([sibling({ amount: -100, currency: 'EUR' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -100, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('treats a null sibling currency as SEK (column default), so SEK companies are unaffected', async () => {
    const supabase = makeSupabase([sibling({ amount: -1616, currency: null })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: null, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
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
  c.order = () => c
  c.limit = () => Promise.resolve(result)
  c.maybeSingle = () => Promise.resolve(result)
  c.single = () => Promise.resolve(result)
  c.in = () => Promise.resolve(result) // terminal for the link-exclusion lookups
  return c
}

/**
 * Chain for the two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts):
 * the helper pages both journal_entries and journal_entry_lines with
 * `.order('id').range(from, to)`, so `.range()` is the terminal. One short
 * page ends the paging loop.
 */
function entryLinesChain(rows: unknown[], singleRow: unknown = null) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'not', 'gt', 'gte', 'lte', 'in', 'contains', 'ilike', 'filter', 'order', 'limit']) {
    c[m] = () => c
  }
  c.range = () => Promise.resolve({ data: rows, error: null })
  c.maybeSingle = () => Promise.resolve({ data: singleRow, error: null })
  c.single = () => Promise.resolve({ data: singleRow, error: null })
  return c
}

/** Tables the ledger scan touches, in call order. */
const tablesTouched: string[] = []

/**
 * A row from the ledger scan's link-exclusion lookup on `transactions`. The
 * bare `{ journal_entry_id }` shape (legacy fixtures) reads as a linking
 * transaction with no amount, which never matches the target: exactly the
 * "reconciled to something else" exclusion behaviour the old tests pinned.
 */
type LedgerTxLink = {
  journal_entry_id: string
  id?: string
  date?: string
  amount?: number | string
  currency?: string | null
  cash_account_id?: string | null
}

function makeLedgerSupabase(opts: {
  ledgerAccount?: string | null
  lines?: Jel[]
  txLinks?: LedgerTxLink[]
  payLinks?: { journal_entry_id: string; transaction_id?: string | null }[]
  transactionRows?: TxRow[] // siblings for the orchestrator fall-through
}) {
  // Fixtures stay embed-shaped for readability; the two-step fetch reads the
  // parent entries and the bare lines separately, so split them here. The
  // helper reattaches the parent under `journal_entry`, reproducing exactly
  // what the old aliased embed returned.
  const jels = opts.lines ?? []
  const entries = [...new Map(jels.map((l) => [l.journal_entry.id, l.journal_entry])).values()]
  const bareLines = jels.map((l, i) => ({
    id: `line-${i}`,
    journal_entry_id: l.journal_entry.id,
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
  }))

  return {
    from: (table: string) => {
      tablesTouched.push(table)
      switch (table) {
        case 'cash_accounts':
          return ledgerChain({
            data: opts.ledgerAccount != null ? { ledger_account: opts.ledgerAccount } : null,
            error: null,
          })
        case 'journal_entries':
          // Two roles: the entry-side page of the two-step fetch (.range) and
          // the sibling scan's voucher-label lookup (.maybeSingle).
          return entryLinesChain(entries, null)
        case 'journal_entry_lines':
          return entryLinesChain(bareLines)
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
  beforeEach(() => {
    tablesTouched.length = 0
  })

  it('drives the scan from journal_entries, never from a cross-tenant line embed', async () => {
    // Shape guard for the entry-lines conversion: the parent entries are
    // fetched first and the lines are fetched by journal_entry_id, so no
    // query starts on journal_entry_lines with the scope on an embed.
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(tablesTouched.indexOf('journal_entries')).toBeGreaterThanOrEqual(0)
    expect(tablesTouched.indexOf('journal_entries')).toBeLessThan(
      tablesTouched.indexOf('journal_entry_lines'),
    )
  })

  it('flags an inbound receipt already booked as a 19xx debit voucher (no sibling tx)', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toEqual({
      transaction_id: null,
      journal_entry_id: 'je-2',
      voucher_label: 'A2',
      entry_date: '2026-03-30',
      description: 'Inbetalning kundfaktura 2026001',
      amount: 98565,
      // The matched leg's account rides along so the dialog's match action
      // links on the exact 19xx the voucher was booked to (issue #919).
      account_number: '1930',
      // The leg is SEK by construction: no foreign context to carry.
      currency: null,
      amount_in_currency: null,
      amount_verified: true,
      unverified_reason: null,
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
      id: 'self', date: '2026-05-04', amount: -16609, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-3')
    expect(result?.transaction_id).toBeNull()
    expect(result?.amount).toBe(16609)
    expect(result?.account_number).toBe('1930')
  })

  it('does NOT flag an inbound receipt against a credit-only voucher (wrong direction)', async () => {
    // A 19xx CREDIT is a payout, not the receipt the inbound line is looking for.
    const supabase = makeLedgerSupabase({ lines: [jel({ debit_amount: 0, credit_amount: 98565 })] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('does NOT flag when the amount differs', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel({ debit_amount: 90000 })] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('excludes a voucher already linked to a transaction', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()], txLinks: [{ journal_entry_id: 'je-2' }] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('excludes a voucher already linked to an invoice payment', async () => {
    const supabase = makeLedgerSupabase({
      lines: [jel()],
      payLinks: [{ journal_entry_id: 'je-2', transaction_id: 'tx-bank' }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  // #2019: a manual / Stripe settlement writes a payment row with no bank
  // transaction. The bank line for that money arrives later; the voucher must
  // stay a twin so the user is offered a link instead of a blind re-booking.
  it('keeps a voucher whose payment row has no bank transaction as a twin', async () => {
    const supabase = makeLedgerSupabase({
      lines: [jel()],
      payLinks: [{ journal_entry_id: 'je-2', transaction_id: null }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-2')
    expect(result?.transaction_id).toBeNull()
  })

  // ── De-exclusion (gap G3): the linking transaction is itself the twin ─────
  it('returns a voucher whose linking transaction itself matches the target, with transaction_id set', async () => {
    // The date-drifted duplicate-import shape: one copy of the bank fee is
    // booked (tx 'twin-1' → je-2), the target is a re-imported copy with a
    // drifted date. The old exclusion dropped je-2 as "reconciled" and BOTH
    // guard halves stayed silent.
    const supabase = makeLedgerSupabase({
      lines: [jel()],
      txLinks: [{
        id: 'twin-1', date: '2026-03-30', amount: 98565, currency: null,
        cash_account_id: null, journal_entry_id: 'je-2',
      }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-2')
    expect(result?.transaction_id).toBe('twin-1')
    expect(result?.account_number).toBe('1930')
  })

  it('still excludes a voucher whose linking transaction differs in amount', async () => {
    // Regression for the exclusion invariant: a voucher reconciled to a
    // NON-matching transaction is genuinely settled by something else.
    const supabase = makeLedgerSupabase({
      lines: [jel()],
      txLinks: [{
        id: 'other-1', date: '2026-03-30', amount: 50000, currency: null,
        cash_account_id: null, journal_entry_id: 'je-2',
      }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('still excludes a voucher whose matching-amount linking transaction is far outside the window', async () => {
    // Same öre but weeks away: a recurring same-amount fee, not this movement.
    const supabase = makeLedgerSupabase({
      lines: [jel()],
      txLinks: [{
        id: 'far-1', date: '2026-04-20', amount: 98565, currency: null,
        cash_account_id: null, journal_entry_id: 'je-2',
      }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('still excludes a voucher whose linking transaction sits on a different known cash account', async () => {
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1930',
      lines: [jel()],
      txLinks: [{
        id: 'acct-1', date: '2026-03-30', amount: 98565, currency: null,
        cash_account_id: 'ca-other', journal_entry_id: 'je-2',
      }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: 'ca-self',
    })
    expect(result).toBeNull()
  })

  it('ignores storno/correction vouchers (valid second vouchers, not duplicates)', async () => {
    const stornoLine = jel({ journal_entry: { ...jel().journal_entry, source_type: 'storno' } })
    const supabase = makeLedgerSupabase({ lines: [stornoLine] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('matches a numeric-string leg amount from PostgREST (öre)', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel({ debit_amount: '98565.00' })] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-2')
  })

  it('returns null for a zero-amount target without querying', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 0, currency: 'SEK', cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  // ── Intra-batch exclusion (bulk-book false-positive fix) ────────────────
  it('excludes a same-batch voucher whose journal_entry.id is in excludeJournalEntryIds', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] }) // jel() → journal_entry.id 'je-2'
    const result = await detectLedgerDuplicateVoucher(
      supabase,
      COMPANY,
      { id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null },
      { excludeJournalEntryIds: ['je-2'] },
    )
    expect(result).toBeNull()
  })

  it('STILL flags a pre-existing voucher not in excludeJournalEntryIds (invariant preserved)', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(
      supabase,
      COMPANY,
      { id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null },
      { excludeJournalEntryIds: ['je-booked-this-batch'] },
    )
    expect(result?.journal_entry_id).toBe('je-2')
  })

  // ── FX: the bank line is foreign, the 19xx leg is always SEK ───────────────
  //
  // Fixture: a 8570.87 EUR receipt booked at 11.5 SEK/EUR lands on the ledger as
  // a 98565 SEK debit (that is what jel() holds). The bank line's own `amount`
  // is 8570.87 and must never be the number compared against the leg.

  it('flags a foreign receipt against the SEK leg its own booking produced', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] }) // 98565 SEK debit
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 8570.87, currency: 'EUR',
      amount_sek: 98565, cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-2')
    expect(result?.amount).toBe(98565)
    expect(result?.amount_verified).toBe(true)
    expect(result?.unverified_reason).toBeNull()
  })

  it('converts via exchange_rate when amount_sek was never stored', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 8570.8695652, currency: 'EUR',
      amount_sek: null, exchange_rate: 11.5, cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-2')
    expect(result?.amount_verified).toBe(true)
  })

  it('does NOT flag a foreign line against an unrelated same-magnitude SEK voucher', async () => {
    // 98565 EUR is ~1.13 MSEK, nothing to do with the 98565 SEK leg. The old
    // guard compared the raw numbers and matched them.
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'EUR',
      amount_sek: 1133497.5, exchange_rate: 11.5, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('WARNS rather than passing when a foreign line has no rate at all', async () => {
    // Neither amount_sek nor exchange_rate: nothing can be compared. Returning
    // null here would wave the booking through and mint a second verifikat for
    // one affärshändelse, so the candidate is surfaced as unverified instead.
    // The bank line sits ONE day from the voucher (2026-03-29 vs 2026-03-30):
    // without an amount comparison, only date-adjacent vouchers may be named.
    const supabase = makeLedgerSupabase({ lines: [jel()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-29', amount: 8570.87, currency: 'EUR',
      amount_sek: null, exchange_rate: null, cash_account_id: null,
    })
    expect(result).not.toBeNull()
    expect(result?.journal_entry_id).toBe('je-2')
    expect(result?.amount_verified).toBe(false)
    expect(result?.unverified_reason).toBe('transaction_missing_sek_value')
    // Still the leg's SEK figure, so no caller can print a foreign number as kr.
    expect(result?.amount).toBe(98565)
  })

  it('does NOT name a voucher days away when the amounts cannot be compared', async () => {
    // Rateless foreign line 4 days from the only 19xx leg in the window. With
    // the amount test skipped, date + account + direction are the only
    // evidence, and a ±7 day pick would attribute an arbitrary unrelated
    // voucher to this bank line in the user-facing warning. Beyond ±1 day the
    // guard stays silent rather than pointing at the wrong verifikat.
    const supabase = makeLedgerSupabase({ lines: [jel()] }) // entry_date 2026-03-30
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 8570.87, currency: 'EUR',
      amount_sek: null, exchange_rate: null, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('still verifies a SEK amount match across the full ±7 day window (verified path unchanged)', async () => {
    // The 1-day gate applies ONLY to the unverified (rateless) path: a SEK
    // line whose amount matched exactly still dedupes 4 days out.
    const supabase = makeLedgerSupabase({ lines: [jel()] }) // 98565 SEK debit, 2026-03-30
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.journal_entry_id).toBe('je-2')
    expect(result?.amount_verified).toBe(true)
  })

  it('returns null (a verified pass) for a rateless foreign line with no 19xx leg in the window', async () => {
    // The existence half of the question needs no currency: no candidate leg at
    // all means there provably is no ledger twin, so this is not a silent pass.
    const supabase = makeLedgerSupabase({ lines: [] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 8570.87, currency: 'EUR',
      amount_sek: null, exchange_rate: null, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('still respects direction and storno filters when the amount cannot be verified', async () => {
    // Same-day target so the storno filter, not the 1-day naming gate, is
    // what removes the candidate.
    const stornoLine = jel({ journal_entry: { ...jel().journal_entry, source_type: 'storno' } })
    const supabase = makeLedgerSupabase({ lines: [stornoLine] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-30', amount: 8570.87, currency: 'EUR',
      amount_sek: null, exchange_rate: null, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('leaves a SEK company on exactly the old path (no FX fields, exact match required)', async () => {
    const supabase = makeLedgerSupabase({ lines: [jel({ debit_amount: 90000 })] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: null, cash_account_id: null,
    })
    expect(result).toBeNull()
  })
})

describe('detectBookingDuplicate (orchestrator)', () => {
  it('returns the sibling transaction when one exists (voucher scan not needed)', async () => {
    const supabase = makeLedgerSupabase({ transactionRows: [sibling()] })
    const result = await detectBookingDuplicate(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('falls through to the ledger voucher when there is no sibling transaction', async () => {
    const supabase = makeLedgerSupabase({ transactionRows: [], lines: [jel()] })
    const result = await detectBookingDuplicate(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
    })
    expect(result?.transaction_id).toBeNull()
    expect(result?.journal_entry_id).toBe('je-2')
  })

  it('returns null when neither a sibling nor a voucher matches', async () => {
    const supabase = makeLedgerSupabase({ transactionRows: [], lines: [] })
    const result = await detectBookingDuplicate(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null,
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
      { id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: null },
      { excludeTransactionIds: ['sib-batch'], excludeJournalEntryIds: ['je-2'] },
    )
    expect(result).toBeNull()
  })
})

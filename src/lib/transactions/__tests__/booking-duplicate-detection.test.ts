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
  /** The database's answer; absent in most fixtures: the row then counts as booked. */
  is_booked?: boolean | null
  /** Provider identity (absent in most fixtures: the ids then cannot speak). */
  external_id?: string | null
  import_source?: string | null
  bank_connection_id?: string | null
  provider_transaction_id?: string | null
  bank_file_import_id?: string | null
}
type JeRow = { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }
/** What readPhysicalKeys reads to tell two rows of one bank account from two accounts. */
type CashRow = { id: string; iban: string | null; currency: string | null }

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
/**
 * Chain for the anchor lookups: the paged slices end on `.order().range()`,
 * the physical-key read on `.in()`, and the chain answers when awaited.
 */
function anchorChain(data: unknown[]) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.in = () => c
  c.order = () => c
  c.range = () => c
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve, reject)
  return c
}
function makeSupabase(
  txData: TxRow[],
  jeData: JeRow | null = { voucher_series: 'A', voucher_number: 142, entry_date: '2025-12-19' },
  anchors: SiblingAnchors = {},
  cashAccounts: CashRow[] = [],
) {
  return {
    from: (table: string) => {
      switch (table) {
        case 'transactions':
          return txChain(txData)
        case 'cash_accounts':
          return anchorChain(cashAccounts)
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
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })], undefined, {}, [
      { id: 'acct-A', iban: 'SE1111', currency: 'SEK' },
      { id: 'acct-B', iban: 'SE2222', currency: 'SEK' },
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: 'acct-B',
    })
    expect(result).toBeNull()
  })

  it('does NOT read two accounts as one without a shared IBAN: a row with no IBAN is its own account', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })], undefined, {}, [
      { id: 'acct-A', iban: null, currency: 'SEK' },
      { id: 'acct-B', iban: null, currency: 'SEK' },
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: 'acct-B',
    })
    expect(result).toBeNull()
  })

  it('flags a sibling on a twin row of the same bank account: a reconnect left one IBAN on two rows', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })], undefined, {}, [
      { id: 'acct-A', iban: 'SE1111', currency: 'SEK' },
      { id: 'acct-B', iban: 'SE1111', currency: 'SEK' },
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: 'acct-B',
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('does NOT flag a sibling the database answers as not booked: a stale pointer is open work, no twin', async () => {
    const supabase = makeSupabase([sibling({ journal_entry_id: 'je-reversed', is_booked: false })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
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
    /** The bank row a bank_transaction verifikat was booked from. */
    source_id?: string | null
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
  // The link-exclusion lookups are paged slices ending on `.order().range()`;
  // the by-id reads end on `.in()`, so the chain answers when awaited.
  c.in = () => c
  c.range = () => Promise.resolve(result)
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
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
  /** null for a bulk-linked row: its anchor is in transaction_voucher_links. */
  journal_entry_id: string | null
  id?: string
  date?: string
  amount?: number | string
  currency?: string | null
  cash_account_id?: string | null
  external_id?: string | null
  import_source?: string | null
  bank_connection_id?: string | null
  provider_transaction_id?: string | null
}

function makeLedgerSupabase(opts: {
  ledgerAccount?: string | null
  lines?: Jel[]
  txLinks?: LedgerTxLink[]
  payLinks?: { journal_entry_id: string; transaction_id?: string | null }[]
  /**
   * Bulk links (bulk_book_transactions); served to both scans and to the
   * covering check's holder read, which needs the slice's allocated_amount
   * and the row it belongs to (the real bank_line shape).
   */
  voucherLinks?: {
    transaction_id: string
    journal_entry_id: string
    role?: string
    allocated_amount?: number
    transactions?: { amount: number; currency: string | null; cash_account_id: string | null }
  }[]
  transactionRows?: TxRow[] // siblings for the orchestrator fall-through
  cashAccounts?: CashRow[] // readPhysicalKeys
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
        case 'cash_accounts': {
          // Two roles: the settlement account of the target (.maybeSingle) and
          // the physical keys of the linked rows (.in).
          const chain = ledgerChain({
            data: opts.ledgerAccount != null ? { ledger_account: opts.ledgerAccount } : null,
            error: null,
          })
          chain.in = () => Promise.resolve({ data: opts.cashAccounts ?? [], error: null })
          return chain
        }
        case 'journal_entries':
          // Two roles: the entry-side page of the two-step fetch (.range) and
          // the sibling scan's voucher-label lookup (.maybeSingle).
          return entryLinesChain(entries, null)
        case 'journal_entry_lines':
          return entryLinesChain(bareLines)
        case 'invoice_payments':
          return ledgerChain({ data: opts.payLinks ?? [], error: null })
        case 'transaction_voucher_links':
          return ledgerChain({ data: opts.voucherLinks ?? null, error: null })
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
      cashAccounts: [
        { id: 'ca-self', iban: 'SE1111', currency: 'SEK' },
        { id: 'ca-other', iban: 'SE2222', currency: 'SEK' },
      ],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: 'ca-self',
    })
    expect(result).toBeNull()
  })

  it('reports a voucher whose linking transaction sits on a twin row of the same bank account', async () => {
    // A reconnect left one IBAN on two rows: another cash_account_id, one account.
    const supabase = makeLedgerSupabase({
      lines: [jel()],
      txLinks: [{
        id: 'twin-1', date: '2026-03-30', amount: 98565, currency: null,
        cash_account_id: 'ca-twin', journal_entry_id: 'je-2',
      }],
      cashAccounts: [
        { id: 'ca-self', iban: 'SE1111', currency: 'SEK' },
        { id: 'ca-twin', iban: 'SE1111', currency: 'SEK' },
      ],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, {
      id: 'self', date: '2026-03-26', amount: 98565, currency: 'SEK', cash_account_id: 'ca-self',
    })
    expect(result?.journal_entry_id).toBe('je-2')
    expect(result?.transaction_id).toBe('twin-1')
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

// ── Provider identity (crm#1271, crm#1277) ───────────────────────────────────
// A Stripe payout carries several fee rows of the same öre, and two customers
// can pay the same price on the same day. Each row's external_id embeds
// Stripe's balance-transaction id, so two different ids are two movements:
// content alone (date, amount, account) called them twins.

const STRIPE_CASH = 'ca-stripe'
const stripeTarget = (over: Record<string, unknown> = {}) => ({
  id: 'self',
  date: '2026-10-12',
  amount: -4.43,
  currency: 'SEK',
  cash_account_id: STRIPE_CASH,
  external_id: 'stripe_acct_A_txn_111_fee',
  import_source: 'stripe',
  bank_connection_id: null,
  ...over,
})
const stripeSibling = (over: Partial<TxRow> = {}): TxRow => ({
  id: 'sib-stripe',
  date: '2026-10-12',
  amount: -4.43,
  description: 'Stripe-avgift',
  cash_account_id: STRIPE_CASH,
  journal_entry_id: 'je-sib',
  external_id: 'stripe_acct_A_txn_222_fee',
  import_source: 'stripe',
  bank_connection_id: null,
  ...over,
})

describe('provider identity: detectBookedDuplicateTransaction', () => {
  it('does NOT flag a same-amount Stripe sibling under a different balance-transaction id', async () => {
    const supabase = makeSupabase([stripeSibling()])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, stripeTarget())
    expect(result).toBeNull()
  })

  it('does NOT flag a customer payment that shares its amount with another customer\'s (distinct ids)', async () => {
    const supabase = makeSupabase([
      stripeSibling({ amount: 50.1, external_id: 'stripe_acct_A_txn_payB', description: 'Stripe-betalning B' }),
    ])
    const result = await detectBookedDuplicateTransaction(
      supabase,
      COMPANY,
      stripeTarget({ amount: 50.1, external_id: 'stripe_acct_A_txn_payA' }),
    )
    expect(result).toBeNull()
  })

  it('still flags a sibling carrying the SAME provider id (the ids cannot clear it)', async () => {
    const supabase = makeSupabase([stripeSibling({ external_id: 'stripe_acct_A_txn_111_fee' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, stripeTarget())
    expect(result?.transaction_id).toBe('sib-stripe')
  })

  it('skips only the proven-distinct sibling and still flags a content twin from another channel', async () => {
    // The Stripe sibling is another booking; the hand-entered row on the same
    // cash account may be this very movement typed in by hand.
    const supabase = makeSupabase([
      stripeSibling(),
      stripeSibling({ id: 'sib-manual', external_id: null, import_source: 'mcp', journal_entry_id: 'je-manual' }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, stripeTarget())
    expect(result?.transaction_id).toBe('sib-manual')
  })

  it('still flags a re-imported bank file duplicate whose synthetic id differs', async () => {
    // File-import ids are row hashes: the same movement imported twice can
    // carry two ids, so a different id proves nothing there.
    const fileRow = { import_source: 'csv_generic_csv', bank_connection_id: null }
    const supabase = makeSupabase([
      sibling({ ...fileRow, external_id: 'generic_csv_aaaa' }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
      ...fileRow, external_id: 'generic_csv_bbbb',
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('still flags a bank-feed sibling whose content-derived id differs (Enable Banking)', async () => {
    const feed = { import_source: 'enable_banking', bank_connection_id: 'bc-1' }
    const supabase = makeSupabase([sibling({ ...feed, external_id: 'eb_SE00_2025-12-19_-161600_1' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, currency: 'SEK', cash_account_id: null,
      ...feed, external_id: 'eb_SE00_2025-12-19_-161600_0',
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('still flags a Stripe sibling when the target carries no identity (a door that omits it)', async () => {
    const supabase = makeSupabase([stripeSibling()])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2026-10-12', amount: -4.43, currency: 'SEK', cash_account_id: STRIPE_CASH,
    })
    expect(result?.transaction_id).toBe('sib-stripe')
  })
})

describe('provider identity: detectLedgerDuplicateVoucher', () => {
  const stripeFeeLeg = (over: Partial<Jel['journal_entry']> = {}) =>
    jel({
      account_number: '1686',
      debit_amount: 0,
      credit_amount: 4.43,
      journal_entry: {
        id: 'je-fee', entry_date: '2026-10-11', description: 'Stripe-avgifter',
        voucher_series: 'A', voucher_number: 375, status: 'posted', source_type: 'manual',
        ...over,
      },
    })

  it('still flags a voucher with no linked transaction (ids cannot decide)', async () => {
    const supabase = makeLedgerSupabase({ ledgerAccount: '1686', lines: [stripeFeeLeg()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, stripeTarget())
    expect(result?.journal_entry_id).toBe('je-fee')
    expect(result?.transaction_id).toBeNull()
  })

  it('excludes a voucher linked to ANOTHER Stripe booking of the same amount (not a twin, not an orphan)', async () => {
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1686',
      lines: [stripeFeeLeg()],
      txLinks: [{
        id: 'sib-stripe', date: '2026-10-11', amount: -4.43, currency: 'SEK',
        cash_account_id: STRIPE_CASH, journal_entry_id: 'je-fee',
        external_id: 'stripe_acct_A_txn_222_fee', import_source: 'stripe', bank_connection_id: null,
      }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, stripeTarget())
    expect(result).toBeNull()
  })

  it('still returns the linked twin when the linking row comes from another channel', async () => {
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1686',
      lines: [stripeFeeLeg()],
      txLinks: [{
        id: 'manual-1', date: '2026-10-11', amount: -4.43, currency: 'SEK',
        cash_account_id: STRIPE_CASH, journal_entry_id: 'je-fee',
        external_id: null, import_source: 'mcp', bank_connection_id: null,
      }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, stripeTarget())
    expect(result?.journal_entry_id).toBe('je-fee')
    expect(result?.transaction_id).toBe('manual-1')
  })
})

describe('provider identity: detectBookingDuplicate (orchestrator)', () => {
  it('clears the crm#1271 shape end to end: a booked same-amount Stripe fee on its own voucher', async () => {
    // Both halves see the other fee: the sibling scan as a booked sibling, the
    // ledger scan as the voucher it is linked to. Neither may call it a twin.
    const booked = stripeSibling({ journal_entry_id: 'je-fee' })
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1686',
      transactionRows: [booked],
      lines: [jel({
        account_number: '1686',
        debit_amount: 0,
        credit_amount: 4.43,
        journal_entry: {
          id: 'je-fee', entry_date: '2026-10-12', description: 'Stripe-avgift',
          voucher_series: 'A', voucher_number: 435, status: 'posted', source_type: 'bank_transaction',
        },
      })],
    })
    const result = await detectBookingDuplicate(supabase, COMPANY, stripeTarget())
    expect(result).toBeNull()
  })
})

// ── Bank-feed and bank-file identity (crm#1312) ──────────────────────────────
// Hundreds of Swish payments of one ticket price arrive through one bank feed.
// After the first day's batch was bulk-booked, every row of the next batch was
// called a copy of a row on that voucher: same amount, a day apart. Two rows of
// one feed booked on different days, or carrying two bank ids, are two
// payments; copies the ids cannot separate and other channels still flag.

const FEED = { import_source: 'enable_banking', bank_connection_id: 'bc-1' }
const swishTarget = (over: Record<string, unknown> = {}) => ({
  id: 'self',
  date: '2026-10-15',
  amount: 395,
  currency: 'SEK',
  cash_account_id: 'ca-bank',
  external_id: 'eb_SE00_2026-10-15_39500_3',
  provider_transaction_id: 'ref-new',
  ...FEED,
  ...over,
})
const bookedSwish = (over: Partial<TxRow> = {}): TxRow => ({
  id: 'sib-a43',
  date: '2026-10-14',
  amount: 395,
  description: 'Swish',
  cash_account_id: 'ca-bank',
  // Bulk-booked: anchored in transaction_voucher_links, not on the row.
  journal_entry_id: null,
  external_id: 'eb_SE00_2026-10-14_39500_3',
  provider_transaction_id: 'ref-old',
  ...FEED,
  ...over,
})
const bulkAnchor = { voucherLinks: [{ transaction_id: 'sib-a43', journal_entry_id: 'je-a43' }] }

describe('bank-feed identity: detectBookedDuplicateTransaction', () => {
  it('does NOT flag a same-price row of the next day against the bulk-booked batch (the crm#1312 shape)', async () => {
    const supabase = makeSupabase([bookedSwish()], undefined, bulkAnchor)
    expect(await detectBookedDuplicateTransaction(supabase, COMPANY, swishTarget())).toBeNull()
  })

  it('does NOT flag a same-day row of the second batch when both rows carry different bank ids', async () => {
    const supabase = makeSupabase(
      [bookedSwish({ date: '2026-10-14', external_id: 'eb_SE00_2026-10-14_39500_2' })],
      undefined,
      bulkAnchor,
    )
    const result = await detectBookedDuplicateTransaction(
      supabase,
      COMPANY,
      swishTarget({ date: '2026-10-14', external_id: 'eb_SE00_2026-10-14_39500_200' }),
    )
    expect(result).toBeNull()
  })

  it('still flags a stored copy of a repeated bank page: same day, same bank id (crm#1295)', async () => {
    const supabase = makeSupabase(
      [bookedSwish({ date: '2026-10-14', external_id: 'eb_SE00_2026-10-14_39500_2', provider_transaction_id: 'ref-a' })],
      undefined,
      bulkAnchor,
    )
    const result = await detectBookedDuplicateTransaction(
      supabase,
      COMPANY,
      swishTarget({ date: '2026-10-14', external_id: 'eb_SE00_2026-10-14_39500_9', provider_transaction_id: 'ref-a' }),
    )
    expect(result?.transaction_id).toBe('sib-a43')
    expect(result?.journal_entry_id).toBe('je-a43')
  })

  it('still flags the same movement from another channel (a bank file on top of the feed)', async () => {
    const supabase = makeSupabase(
      [bookedSwish({ import_source: 'csv_nordea_business', bank_connection_id: null, external_id: 'nordea_x', provider_transaction_id: null })],
      undefined,
      bulkAnchor,
    )
    expect((await detectBookedDuplicateTransaction(supabase, COMPANY, swishTarget()))?.transaction_id).toBe('sib-a43')
  })

  it('still flags a row of a reconnected bank (another connection) a day apart', async () => {
    const supabase = makeSupabase([bookedSwish({ bank_connection_id: 'bc-old' })], undefined, bulkAnchor)
    expect((await detectBookedDuplicateTransaction(supabase, COMPANY, swishTarget()))?.transaction_id).toBe('sib-a43')
  })

  it('does NOT flag another row of the same uploaded bank file, and still flags the same row from a second upload', async () => {
    const file = { import_source: 'csv_nordea_business', bank_connection_id: null, provider_transaction_id: null }
    const target = swishTarget({ ...file, external_id: 'nordea_bbbb', bank_file_import_id: 'bfi-1' })
    const sameFile = makeSupabase([bookedSwish({ ...file, external_id: 'nordea_aaaa', bank_file_import_id: 'bfi-1' })], undefined, bulkAnchor)
    expect(await detectBookedDuplicateTransaction(sameFile, COMPANY, target)).toBeNull()
    const secondUpload = makeSupabase([bookedSwish({ ...file, external_id: 'nordea_aaaa', bank_file_import_id: 'bfi-0' })], undefined, bulkAnchor)
    expect((await detectBookedDuplicateTransaction(secondUpload, COMPANY, target))?.transaction_id).toBe('sib-a43')
  })
})

describe('bulk links: detectLedgerDuplicateVoucher', () => {
  // A one_line_per_tx samlingsverifikat (or a link to an existing voucher)
  // carries a 395 kr bank leg per row, and its rows are anchored only in
  // transaction_voucher_links.
  const bulkLeg = () =>
    jel({
      account_number: '1930',
      debit_amount: 395,
      credit_amount: 0,
      journal_entry: {
        id: 'je-a43', entry_date: '2026-10-14', description: 'Swish-försäljning',
        voucher_series: 'A', voucher_number: 43, status: 'posted', source_type: 'manual',
      },
    })
  const linkedRow = (over: Partial<LedgerTxLink> = {}): LedgerTxLink => ({
    id: 'sib-a43', date: '2026-10-14', amount: 395, currency: 'SEK', cash_account_id: 'ca-bank',
    journal_entry_id: null, external_id: 'eb_SE00_2026-10-14_39500_3', provider_transaction_id: 'ref-old', ...FEED,
    ...over,
  })

  it('excludes a voucher whose bank leg is bulk-linked to another payment (reconciled, not an orphan)', async () => {
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1930', lines: [bulkLeg()], txLinks: [linkedRow()],
      voucherLinks: [{ transaction_id: 'sib-a43', journal_entry_id: 'je-a43' }],
    })
    expect(await detectLedgerDuplicateVoucher(supabase, COMPANY, swishTarget())).toBeNull()
  })

  it('returns the bulk-linked twin when the linked row is the same movement from another channel', async () => {
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1930', lines: [bulkLeg()],
      txLinks: [linkedRow({ import_source: 'csv_nordea_business', bank_connection_id: null, external_id: 'nordea_x', provider_transaction_id: null })],
      voucherLinks: [{ transaction_id: 'sib-a43', journal_entry_id: 'je-a43' }],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, swishTarget())
    expect(result?.journal_entry_id).toBe('je-a43')
    expect(result?.transaction_id).toBe('sib-a43')
  })

  it('still flags the same voucher when nothing is linked to it (a hand-posted orphan)', async () => {
    const supabase = makeLedgerSupabase({ ledgerAccount: '1930', lines: [bulkLeg()] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, swishTarget())
    expect(result?.journal_entry_id).toBe('je-a43')
    expect(result?.transaction_id).toBeNull()
  })
})

describe('bank-feed identity: detectBookingDuplicate (orchestrator)', () => {
  it('clears the crm#1312 shape end to end: neither the sibling scan nor the bulk-linked voucher flags it', async () => {
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1930',
      transactionRows: [bookedSwish()],
      // The bulk link holds the voucher's whole 395 kr, so the covering check
      // (issue #101) finds no unlinked part for a second Swish either.
      voucherLinks: [{
        transaction_id: 'sib-a43', journal_entry_id: 'je-a43', role: 'bank_line', allocated_amount: 395,
        transactions: { amount: 395, currency: 'SEK', cash_account_id: 'ca-bank' },
      }],
      lines: [jel({
        account_number: '1930', debit_amount: 395, credit_amount: 0,
        journal_entry: {
          id: 'je-a43', entry_date: '2026-10-14', description: 'Swish-försäljning',
          voucher_series: 'A', voucher_number: 43, status: 'posted', source_type: 'manual',
        },
      })],
    })
    expect(await detectBookingDuplicate(supabase, COMPANY, swishTarget())).toBeNull()
  })
})

describe('a bank-row verifikat whose link has not landed: detectLedgerDuplicateVoucher', () => {
  // 2026-10-29: one Stripe-fee verifikat booked from its own bank row, but not
  // (yet) linked from it (a parallel booking between its commit and its link,
  // or a link the busy bank-account lock refused), read as a ledger-only
  // orphan, and every other fee of the same öre within the week was refused as
  // its duplicate, each with its own Stripe id.
  const STRIPE = { import_source: 'stripe', bank_connection_id: null, provider_transaction_id: null }
  const feeTarget = {
    id: 'fee-b', date: '2026-08-09', amount: -2.79, currency: 'SEK', cash_account_id: 'ca-stripe',
    external_id: 'stripe_acct_1_txn_B', ...STRIPE,
  }
  const feeVoucher = (sourceId: string) =>
    jel({
      account_number: '1930',
      debit_amount: 0,
      credit_amount: 2.79,
      journal_entry: {
        id: 'je-fee-a', entry_date: '2026-08-09', description: 'Stripe-avgift',
        voucher_series: 'A', voucher_number: 349, status: 'posted', source_type: 'bank_transaction', source_id: sourceId,
      },
    })
  const sourceRow = (over: Partial<LedgerTxLink> = {}): LedgerTxLink => ({
    id: 'fee-a', date: '2026-08-09', amount: -2.79, currency: 'SEK', cash_account_id: 'ca-stripe',
    journal_entry_id: null, external_id: 'stripe_acct_1_txn_A', ...STRIPE, ...over,
  })

  it('does not call it a duplicate of another bank row its ids prove distinct', async () => {
    const supabase = makeLedgerSupabase({ ledgerAccount: '1930', lines: [feeVoucher('fee-a')], txLinks: [sourceRow()] })
    expect(await detectLedgerDuplicateVoucher(supabase, COMPANY, feeTarget)).toBeNull()
  })

  it('returns it as the twin when its bank row is the same movement from another channel', async () => {
    const supabase = makeLedgerSupabase({
      ledgerAccount: '1930', lines: [feeVoucher('fee-a')],
      txLinks: [sourceRow({ import_source: 'csv_generic_csv', external_id: 'csv_1' })],
    })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, feeTarget)
    expect(result?.journal_entry_id).toBe('je-fee-a')
    expect(result?.transaction_id).toBe('fee-a')
  })

  it('still flags a verifikat booked from this very row: the row is booked already', async () => {
    const supabase = makeLedgerSupabase({ ledgerAccount: '1930', lines: [feeVoucher('fee-b')] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, feeTarget)
    expect(result?.journal_entry_id).toBe('je-fee-a')
    expect(result?.transaction_id).toBeNull()
  })

  it('judges it as before when its bank row cannot be read', async () => {
    const supabase = makeLedgerSupabase({ ledgerAccount: '1930', lines: [feeVoucher('fee-gone')] })
    const result = await detectLedgerDuplicateVoucher(supabase, COMPANY, feeTarget)
    expect(result?.journal_entry_id).toBe('je-fee-a')
  })
})

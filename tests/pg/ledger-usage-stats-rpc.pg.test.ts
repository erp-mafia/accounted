/**
 * pg-real test for get_ledger_usage_stats + normalize_counterparty_key.
 *
 * The RPC backs the Accounted://ledger/context MCP resource: one jsonb
 * document with windowed account-usage, counterparty-pattern, and
 * supplier-pattern aggregates. Verifies: posted-only filtering, the date
 * window, dominant category/account derivation (19xx contra exclusion),
 * splinter-merging merchant normalization (payment-rail prefixes, dates,
 * legal suffixes), storno exclusion from account_usage, supplier-side
 * aggregation (credit notes and reversed invoices excluded), and two-company
 * isolation (a foreign company id yields empty sections).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import {
  seedCompany,
  insertDraftJournalEntry,
} from './fixtures'

async function insertLines(
  journalEntryId: string,
  lines: Array<{ account: string; debit: number; credit: number }>,
): Promise<void> {
  for (const line of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [journalEntryId, line.account, line.debit, line.credit],
    )
  }
}

async function insertBookedTransaction(params: {
  companyId: string
  userId: string
  journalEntryId: string
  merchantName: string
  category: string
  date: string
  amount?: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description,
        journal_entry_id, merchant_name, category)
     VALUES ($1, $2, $3, 'SEK', $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      params.companyId,
      params.userId,
      params.amount ?? -500,
      params.date,
      `Payment ${params.merchantName}`,
      params.journalEntryId,
      params.merchantName,
      params.category,
    ],
  )
}

/** ISO date + n days, as a UTC timestamptz string (for committed_at). */
function plusDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString()
}

// Posted entry + lines + a booked transaction pointing at it, in one call.
async function bookMerchant(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  merchantName: string
  category: string
  date: string
  expenseAccount: string
  voucherNumber: number
  sourceType?: string
}): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date,
    status: 'posted',
    voucherNumber: params.voucherNumber,
    sourceType: params.sourceType ?? 'bank_transaction',
    // Booked 3 days after the transaction: exercises the committed_at-based
    // lag (entry_date == transaction date would give 0).
    committedAt: plusDays(params.date, 3),
  })
  await insertLines(entryId, [
    { account: params.expenseAccount, debit: 500, credit: 0 },
    { account: '1930', debit: 0, credit: 500 },
  ])
  await insertBookedTransaction({
    companyId: params.companyId,
    userId: params.userId,
    journalEntryId: entryId,
    merchantName: params.merchantName,
    category: params.category,
    date: params.date,
  })
  return entryId
}

async function insertSupplierWithInvoices(params: {
  userId: string
  companyId: string
  name: string
  invoices: Array<{
    invoiceDate: string
    account: string
    vatTreatment?: string
    status?: string
    isCreditNote?: boolean
    extraItemAccounts?: string[]
  }>
  arrivalStart: number
}): Promise<void> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, $4)`,
    [supplierId, params.userId, params.companyId, params.name],
  )
  let arrival = params.arrivalStart
  for (const inv of params.invoices) {
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number,
          supplier_invoice_number, invoice_date, due_date, status,
          vat_treatment, is_credit_note, subtotal, vat_amount, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, 1000, 250, 1250)`,
      [
        invoiceId,
        params.userId,
        params.companyId,
        supplierId,
        arrival++,
        `SI-${arrival}`,
        inv.invoiceDate,
        inv.status ?? 'registered',
        inv.vatTreatment ?? 'standard_25',
        inv.isCreditNote ?? false,
      ],
    )
    for (const account of [inv.account, ...(inv.extraItemAccounts ?? [])]) {
      await getPool().query(
        `INSERT INTO public.supplier_invoice_items
           (supplier_invoice_id, description, quantity, unit_price, line_total,
            account_number, vat_rate, vat_amount)
         VALUES ($1, 'Line', 1, 1000, 1000, $2, 0.25, 250)`,
        [invoiceId, account],
      )
    }
  }
}

type LedgerStats = {
  account_usage: Array<{
    account_number: string
    account_name: string | null
    postings: number
    last_used: string
  }>
  counterparty_patterns: Array<{
    counterparty: string
    counterparty_key: string
    occurrences: number
    last_booked: string
    dominant_category: string | null
    dominant_category_count: number
    dominant_account_number: string | null
  }>
  supplier_patterns: Array<{
    supplier: string
    invoices: number
    last_invoice: string
    vat_treatment: string | null
    dominant_account_number: string | null
    dominant_account_count: number
  }>
  vat_treatments_used: string[]
  median_booking_lag_days: number | null
}

async function callRpc(companyId: string, fromDate: string): Promise<LedgerStats> {
  const res = await getPool().query(
    `SELECT public.get_ledger_usage_stats($1, $2) AS stats`,
    [companyId, fromDate],
  )
  return res.rows[0].stats as LedgerStats
}

describe('normalize_counterparty_key', () => {
  async function normalize(raw: string): Promise<string> {
    const res = await getPool().query(
      `SELECT public.normalize_counterparty_key($1) AS key`,
      [raw],
    )
    return res.rows[0].key as string
  }

  it('mirrors normalizeCounterpartyName for the splinter cases', async () => {
    // Payment-rail prefix + trailing date.
    expect(await normalize('KLARNA AB 2026-07-01')).toBe('klarna')
    expect(await normalize('KLARNA AB')).toBe('klarna')
    expect(await normalize('SWISH KLARNA AB')).toBe('klarna')
    expect(await normalize('KORTKÖP KLARNA AB')).toBe('klarna')
    // Faithful-mirror check: bare KORT is NOT a stripped prefix in
    // normalizeCounterpartyName() either (only KORTKÖP). Hardening the prefix
    // list is Layer B of bank_transaction_ai_normalization.md and must change
    // the TS + SQL pair together, or the categorization_templates join drifts.
    expect(await normalize('KORT KLARNA AB')).toBe('kort klarna')
    // Legal suffix + casing.
    expect(await normalize('Telia Sverige AB')).toBe('telia sverige')
    // Trailing initials and month tokens (the ngrok bug).
    expect(await normalize('ngrok JW')).toBe('ngrok')
    expect(await normalize('Ngrok Mars')).toBe('ngrok')
    // Invoice references.
    expect(await normalize('Acme INV-123')).toBe('acme')
    // Never strips to empty: keeps the last token.
    expect(await normalize('SEB')).toBe('seb')
    // NULL-safe.
    const res = await getPool().query(
      `SELECT public.normalize_counterparty_key(NULL) AS key`,
    )
    expect(res.rows[0].key).toBe('')
  })
})

describe('get_ledger_usage_stats', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    fiscalPeriodId = seeded.fiscalPeriodId

    // 3x Klarna to 6570 under splintered labels (prefix/date/casing variants
    // that must merge), 1x Klarna miscategorized, 2x SL to 5810, plus a draft
    // that must not count and an old entry outside the window.
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'KLARNA AB', category: 'expense_bank_fees', date: '2026-05-01', expenseAccount: '6570', voucherNumber: 1 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'KORTKÖP KLARNA AB 2026-05-15', category: 'expense_bank_fees', date: '2026-05-15', expenseAccount: '6570', voucherNumber: 2 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'Klarna AB', category: 'expense_bank_fees', date: '2026-06-01', expenseAccount: '6570', voucherNumber: 3 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'SWISH KLARNA AB', category: 'expense_other', date: '2026-06-10', expenseAccount: '6570', voucherNumber: 4 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'SL', category: 'expense_travel', date: '2026-06-05', expenseAccount: '5810', voucherNumber: 5 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'SL', category: 'expense_travel', date: '2026-06-20', expenseAccount: '5810', voucherNumber: 6 })

    // A storno pair: original already excluded via status='reversed'; the
    // storno entry itself is posted and must be excluded from account_usage
    // by the source_type filter. 4010 must NOT gain postings from either.
    const stornoOriginalId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-15', status: 'reversed', voucherNumber: 8,
      sourceType: 'bank_transaction',
    })
    await insertLines(stornoOriginalId, [
      { account: '4010', debit: 300, credit: 0 },
      { account: '1930', debit: 0, credit: 300 },
    ])
    const stornoId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-15', status: 'posted', voucherNumber: 9,
      sourceType: 'storno',
    })
    await insertLines(stornoId, [
      { account: '1930', debit: 300, credit: 0 },
      { account: '4010', debit: 0, credit: 300 },
    ])
    // Legacy shape: a transaction still linked to the storno entry (predates
    // reverseEntry() unlinking). Must not create a counterparty pattern.
    await insertBookedTransaction({
      companyId, userId,
      journalEntryId: stornoId,
      merchantName: 'STORNO VENDOR',
      category: 'expense_other',
      date: '2026-06-15',
    })

    // Draft entry: must not appear in account_usage.
    const draftId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-25', status: 'draft', voucherNumber: 0,
    })
    await insertLines(draftId, [
      { account: '9999', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 100 },
    ])

    // Outside the window: must not count.
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'OLD VENDOR', category: 'expense_other', date: '2026-01-05', expenseAccount: '4010', voucherNumber: 7 })

    // Reverse-charge EU purchase (foreign SaaS): lines are expense (5420) +
    // calc input VAT (2645) + calc output VAT (2614) + bank (1930), tying at
    // equal counts. The dominant contra must be the expense 5420, NOT the low
    // VAT number 2614 that the account_number tiebreak would otherwise pick
    // (regression for 20260708110000; observed on prod as 2614).
    let rcVoucher = 20
    for (const d of ['2026-05-20', '2026-06-18']) {
      const rcEntry = await insertDraftJournalEntry({
        userId, companyId, fiscalPeriodId,
        entryDate: d, status: 'posted',
        voucherNumber: rcVoucher++, sourceType: 'bank_transaction',
        committedAt: plusDays(d, 3),
      })
      await insertLines(rcEntry, [
        { account: '5420', debit: 500, credit: 0 },
        { account: '2645', debit: 125, credit: 0 },
        { account: '2614', debit: 0, credit: 125 },
        { account: '1930', debit: 0, credit: 500 },
      ])
      await insertBookedTransaction({
        companyId, userId, journalEntryId: rcEntry,
        merchantName: 'GOOGLE WO', category: 'expense_software', date: d,
      })
    }

    // Suppliers: Telia with 3 consistent invoices (one of them multi-line,
    // which must not outvote), one credit note and one reversed invoice that
    // must both be excluded; Blandat with a 1/2 split staying below any
    // dominance and one invoice outside the window.
    await insertSupplierWithInvoices({
      userId, companyId, name: 'Telia Sverige AB', arrivalStart: 1,
      invoices: [
        { invoiceDate: '2026-05-05', account: '6212' },
        { invoiceDate: '2026-06-05', account: '6212', extraItemAccounts: ['6212', '6212'] },
        { invoiceDate: '2026-06-25', account: '6212' },
        { invoiceDate: '2026-06-26', account: '6212', isCreditNote: true },
        { invoiceDate: '2026-06-27', account: '6212', status: 'reversed' },
      ],
    })
    await insertSupplierWithInvoices({
      userId, companyId, name: 'Blandat AB', arrivalStart: 10,
      invoices: [
        { invoiceDate: '2026-06-01', account: '4010' },
        { invoiceDate: '2026-06-02', account: '5460' },
        { invoiceDate: '2026-01-02', account: '4010' },
      ],
    })

    // Invoices carrying VAT treatments: one in-window, one before the window.
    await getPool().query(
      `INSERT INTO public.invoices
         (company_id, user_id, invoice_number, invoice_date, due_date, vat_treatment)
       VALUES ($1, $2, 'INV-1', '2026-06-01', '2026-06-30', 'standard_25'),
              ($1, $2, 'INV-2', '2026-01-02', '2026-01-31', 'reverse_charge_eu')`,
      [companyId, userId],
    )
  })

  it('aggregates posted account usage within the window, excluding stornos', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const byAccount = Object.fromEntries(
      stats.account_usage.map((a) => [a.account_number, a]),
    )

    // 8 posted in-window bank entries each carry a 1930 line (6 simple + 2
    // reverse-charge); the storno's 1930 line is excluded by source_type.
    expect(byAccount['1930'].postings).toBe(8)
    expect(byAccount['6570'].postings).toBe(4)
    expect(byAccount['5810'].postings).toBe(2)
    expect(byAccount['5810'].last_used).toBe('2026-06-20')
    // The reverse-charge fixture's expense and VAT lines all appear in
    // account_usage (which does not exclude 26xx: it answers "what accounts
    // are used", not "what characterizes a counterparty").
    expect(byAccount['5420'].postings).toBe(2)
    expect(byAccount['2614'].postings).toBe(2)

    // Neither the reversed original nor its storno may credit 4010 postings,
    // and the draft line and out-of-window account are absent.
    expect(byAccount['4010']).toBeUndefined()
    expect(byAccount['9999']).toBeUndefined()
  })

  it('merges splintered merchant labels into one normalized counterparty', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const klarna = stats.counterparty_patterns.find(
      (p) => p.counterparty_key === 'klarna',
    )
    expect(klarna).toBeDefined()
    // KLARNA AB / KORTKÖP ... 2026-05-15 / Klarna AB / SWISH KLARNA AB: one key.
    expect(klarna!.occurrences).toBe(4)
    expect(klarna!.dominant_category).toBe('expense_bank_fees')
    expect(klarna!.dominant_category_count).toBe(3)
    // 1930 excluded, so the expense side wins.
    expect(klarna!.dominant_account_number).toBe('6570')
    expect(klarna!.last_booked).toBe('2026-06-10')
    // No second Klarna-ish row survives the merge.
    expect(
      stats.counterparty_patterns.filter((p) => p.counterparty_key.includes('klarna')),
    ).toHaveLength(1)

    const sl = stats.counterparty_patterns.find((p) => p.counterparty_key === 'sl')
    expect(sl!.occurrences).toBe(2)
    expect(sl!.dominant_account_number).toBe('5810')

    // Out-of-window merchant absent.
    expect(
      stats.counterparty_patterns.find((p) => p.counterparty === 'OLD VENDOR'),
    ).toBeUndefined()

    // A transaction still linked to a storno entry (legacy rows predating the
    // reverseEntry unlink) must not surface as a pattern.
    expect(
      stats.counterparty_patterns.find((p) => p.counterparty === 'STORNO VENDOR'),
    ).toBeUndefined()
  })

  it('picks the expense over a VAT contra for reverse-charge bookings', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const google = stats.counterparty_patterns.find((p) => p.counterparty_key === 'google')
    expect(google).toBeDefined()
    expect(google!.occurrences).toBe(2)
    // 5420/2645/2614 tie at equal counts; excluding 26xx leaves the expense.
    // Without the fix the account_number tiebreak would return 2614.
    expect(google!.dominant_account_number).toBe('5420')
  })

  it('orders counterparties by occurrences descending', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const occurrences = stats.counterparty_patterns.map((p) => p.occurrences)
    expect(occurrences).toEqual([...occurrences].sort((a, b) => b - a))
  })

  it('aggregates supplier patterns excluding credit notes and reversed invoices', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const telia = stats.supplier_patterns.find((s) => s.supplier === 'Telia Sverige AB')
    expect(telia).toBeDefined()
    // 3 live invoices; the credit note and the reversed one are excluded.
    expect(telia!.invoices).toBe(3)
    expect(telia!.last_invoice).toBe('2026-06-25')
    expect(telia!.vat_treatment).toBe('standard_25')
    expect(telia!.dominant_account_number).toBe('6212')
    // Counted per invoice, not per line: the multi-line invoice adds 1.
    expect(telia!.dominant_account_count).toBe(3)

    const blandat = stats.supplier_patterns.find((s) => s.supplier === 'Blandat AB')
    // Only the two in-window invoices; 1/2 agree on the dominant account.
    expect(blandat!.invoices).toBe(2)
    expect(blandat!.dominant_account_count).toBe(1)
  })

  it('reports window-scoped VAT treatments and median booking lag', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    expect(stats.vat_treatments_used).toContain('standard_25')
    expect(stats.vat_treatments_used).not.toContain('reverse_charge_eu')
    // Every booked fixture sets committed_at = transaction date + 3 days, so
    // the lag is measured from committed_at (not entry_date, which == the
    // transaction date and would give a misleading 0).
    expect(stats.median_booking_lag_days).toBe(3)
  })

  it('returns empty sections for a company with no data (isolation)', async () => {
    const other = await seedCompany()
    const stats = await callRpc(other.companyId, '2026-04-01')
    expect(stats.account_usage).toEqual([])
    expect(stats.counterparty_patterns).toEqual([])
    expect(stats.supplier_patterns).toEqual([])
    expect(stats.vat_treatments_used).toEqual([])
    expect(stats.median_booking_lag_days).toBeNull()
  })

  it('does not leak data across companies with identical merchants', async () => {
    const other = await seedCompany()
    await bookMerchant({
      userId: other.userId,
      companyId: other.companyId,
      fiscalPeriodId: other.fiscalPeriodId,
      merchantName: 'KLARNA AB',
      category: 'expense_card_fees',
      date: '2026-06-01',
      expenseAccount: '6580',
      voucherNumber: 1,
    })

    const stats = await callRpc(other.companyId, '2026-04-01')
    const klarna = stats.counterparty_patterns.find(
      (p) => p.counterparty_key === 'klarna',
    )
    // Only its own single booking; the first company's 4 do not bleed in.
    expect(klarna!.occurrences).toBe(1)
    expect(klarna!.dominant_category).toBe('expense_card_fees')
    expect(klarna!.dominant_account_number).toBe('6580')
  })
})

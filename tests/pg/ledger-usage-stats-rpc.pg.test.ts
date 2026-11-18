/**
 * pg-real test for get_ledger_usage_stats + normalize_counterparty_key.
 *
 * The RPC backs the Accounted://ledger/context MCP resource: one jsonb
 * document with windowed account-usage, counterparty-pattern, and
 * supplier-pattern aggregates. Verifies: posted-only filtering, the date
 * window, dominant category/account derivation (19xx contra exclusion),
 * splinter-merging merchant normalization (payment-rail prefixes, dates,
 * legal suffixes), storno exclusion from account_usage, supplier-side
 * aggregation (credit notes and reversed invoices excluded; moms,
 * öresavrundning, skuld and bank rows never the dominant account, crm#1310),
 * and two-company isolation (a foreign company id yields empty sections).
 * Counterparty patterns key on the text the counterparty templates learn
 * from (merchant name, else original_description, else description), so a
 * feed without merchant names still gets patterns, on the template key. *
 * imported_counterparty_patterns (20261109090100): imported verifikat as a
 * second basis. Only verifikat settled through money (19xx or a card ledger)
 * or reskontra (244x/151x), not both, so payments never teach 2440/1930; the
 * counterparty read out of the previous system's wrapper text on the same
 * key as bank rows; booking account and VAT treatment read off the lines.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { namesCounterparty, normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { getPool } from './setup'
import {
  seedCompany,
  insertDraftJournalEntry,
  insertPostedJournalEntry,
  insertPostedBankJournalEntry,
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
  journalEntryId: string | null
  merchantName: string | null
  originalDescription?: string | null
  description?: string
  category: string
  date: string
  amount?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description,
        journal_entry_id, merchant_name, category, original_description)
     VALUES ($1, $2, $3, 'SEK', $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      params.companyId,
      params.userId,
      params.amount ?? -500,
      params.date,
      params.description ?? `Payment ${params.merchantName}`,
      params.journalEntryId,
      params.merchantName,
      params.category,
      params.originalDescription ?? null,
    ],
  )
  return id
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
  merchantName: string | null
  originalDescription?: string | null
  description?: string
  category: string
  date: string
  expenseAccount: string
  voucherNumber: number
  sourceType?: string
}): Promise<string> {
  const transactionId = await insertBookedTransaction({
    companyId: params.companyId,
    userId: params.userId,
    journalEntryId: null,
    merchantName: params.merchantName,
    originalDescription: params.originalDescription,
    description: params.description,
    category: params.category,
    date: params.date,
  })
  const entryParams = {
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date,
    voucherNumber: params.voucherNumber,
    // Booked 3 days after the transaction: exercises the committed_at-based
    // lag (entry_date == transaction date would give 0).
    committedAt: plusDays(params.date, 3),
    lines: [
      { accountNumber: params.expenseAccount, debitAmount: 500, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
    ],
  }
  const entryId = params.sourceType && params.sourceType !== 'bank_transaction'
    ? await insertPostedJournalEntry({ ...entryParams, sourceType: params.sourceType })
    : await insertPostedBankJournalEntry({ ...entryParams, transactionId })
  await getPool().query('UPDATE transactions SET journal_entry_id = $2 WHERE id = $1', [transactionId, entryId])
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
        // A credit note rests at 'credited' (never a payable): the CHECK
        // supplier_invoices_credit_note_not_payable refuses 'registered'.
        inv.status ?? (inv.isCreditNote ? 'credited' : 'registered'),
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
  imported_counterparty_patterns: Array<{
    counterparty: string
    counterparty_key: string
    vouchers: number
    last_booked: string
    settled_via: string
    dominant_account_number: string | null
    dominant_account_count: number
    vat_treatment: string | null
    vat_treatment_count: number
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
    // Card-network descriptors: merchant segment before the star, per-charge
    // product/ref/city tail dropped (the Anthropic splinter bug). Processor
    // prefixes keep the merchant AFTER the star instead.
    expect(await normalize('ANTHROPIC* CLAUDE SUB SAN FRANCISCO')).toBe('anthropic')
    expect(await normalize('ANTHROPIC*CLAUDE SUB +14155551234')).toBe('anthropic')
    expect(await normalize('PAYPAL *SPOTIFY')).toBe('spotify')
    expect(await normalize('SQ *BLUE BOTTLE COFFEE')).toBe('blue bottle coffee')
    expect(await normalize('AMZN MKTP SE*A12B34CD5')).toBe('amzn mktp')
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
      entryDate: '2026-06-15', status: 'draft', voucherNumber: 9,
    })
    await insertLines(stornoId, [
      { account: '1930', debit: 300, credit: 0 },
      { account: '4010', debit: 0, credit: 300 },
    ])
    // Legacy shape: a transaction still linked to the storno entry (predates
    // reverseEntry() unlinking). Must not create a counterparty pattern. The
    // pointer guard refuses this write since 20261101023500 and leaves the rows
    // that already have it, so the row goes on before the entry is a storno.
    await insertBookedTransaction({
      companyId, userId,
      journalEntryId: stornoId,
      amount: 300,
      merchantName: 'STORNO VENDOR',
      category: 'expense_other',
      date: '2026-06-15',
    })
    await getPool().query(`UPDATE public.journal_entries SET source_type = 'storno', status = 'posted' WHERE id = $1`, [stornoId])

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
    // (regression for 20260708110000; observed in production as 2614).
    let rcVoucher = 20
    for (const d of ['2026-05-20', '2026-06-18']) {
      const transactionId = await insertBookedTransaction({
        companyId, userId, journalEntryId: null,
        merchantName: 'GOOGLE WO', category: 'expense_software', date: d,
      })
      const rcEntry = await insertPostedBankJournalEntry({
        userId, companyId, fiscalPeriodId,
        entryDate: d,
        voucherNumber: rcVoucher++, transactionId,
        committedAt: plusDays(d, 3),
        lines: [
          { accountNumber: '5420', debitAmount: 500, creditAmount: 0 },
          { accountNumber: '2645', debitAmount: 125, creditAmount: 0 },
          { accountNumber: '2614', debitAmount: 0, creditAmount: 125 },
          { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
        ],
      })
      await getPool().query('UPDATE transactions SET journal_entry_id = $2 WHERE id = $1', [transactionId, rcEntry])
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
    // crm#1310: rows in the shape the provider migration and register-booked
    // store, the ingående moms as a row of its own (2641) and an
    // öresavrundning row (3740). 2641 is on all three invoices, the cost
    // only on two: counting every row named 2641 the dominant account.
    await insertSupplierWithInvoices({
      userId, companyId, name: 'Programvara AB', arrivalStart: 20,
      invoices: [
        { invoiceDate: '2026-05-03', account: '5420', extraItemAccounts: ['2641', '3740'] },
        { invoiceDate: '2026-06-03', account: '5420', extraItemAccounts: ['2641'] },
        { invoiceDate: '2026-06-13', account: '6540', extraItemAccounts: ['2641'] },
      ],
    })
    // One invoice, one cost row and one moms row: a tie the account_number
    // tiebreak used to hand to '2641'.
    await insertSupplierWithInvoices({
      userId, companyId, name: 'Momsrad AB', arrivalStart: 30,
      invoices: [{ invoiceDate: '2026-06-14', account: '2641', extraItemAccounts: ['5420'] }],
    })
    // Only moms (a forwarder's import-VAT bill): no kontering to report.
    await insertSupplierWithInvoices({
      userId, companyId, name: 'Bara Moms AB', arrivalStart: 40,
      invoices: [{ invoiceDate: '2026-06-15', account: '2641' }],
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

  it('reports the cost account as the dominant account, never moms or öresavrundning (crm#1310)', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const programvara = stats.supplier_patterns.find((s) => s.supplier === 'Programvara AB')
    expect(programvara).toMatchObject({ invoices: 3, dominant_account_number: '5420', dominant_account_count: 2 })

    const tie = stats.supplier_patterns.find((s) => s.supplier === 'Momsrad AB')
    expect(tie).toMatchObject({ invoices: 1, dominant_account_number: '5420', dominant_account_count: 1 })

    // Still listed (the invoices happened), with no account to follow.
    const onlyVat = stats.supplier_patterns.find((s) => s.supplier === 'Bara Moms AB')
    expect(onlyVat).toMatchObject({ invoices: 1, dominant_account_number: null, dominant_account_count: 0 })

    for (const s of stats.supplier_patterns) {
      expect(s.dominant_account_number ?? '').not.toMatch(/^(19|244|26)|^3740$/)
    }
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

describe('get_ledger_usage_stats: feeds without a merchant name', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string
  let voucher = 1
  // ASCII only: the key must not depend on the database's case-folding locale.
  const LONG_TEXT = `Butik Med Ett Mycket Langt Namn ${'Stockholm '.repeat(8)}`.trim()

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    fiscalPeriodId = seeded.fiscalPeriodId
    const book = (row: {
      merchantName?: string | null
      originalDescription?: string | null
      description: string
      category?: string
      account?: string
      date?: string
    }) =>
      bookMerchant({
        userId, companyId, fiscalPeriodId,
        merchantName: row.merchantName ?? null,
        originalDescription: row.originalDescription ?? null,
        description: row.description,
        category: row.category ?? 'expense_software',
        date: row.date ?? '2026-06-01',
        expenseAccount: row.account ?? '5420',
        voucherNumber: voucher++,
      })

    // The bank's original text carries the counterparty (no merchant name);
    // the working title was trimmed at ingest. Three spellings, one key.
    await book({ originalDescription: 'KORTKÖP SPOTIFY AB 2026-05-01', description: 'SPOTIFY AB', date: '2026-05-01' })
    await book({ originalDescription: 'Spotify AB', description: 'Spotify', date: '2026-05-31' })
    await book({ originalDescription: 'SPOTIFY AB', description: 'Musik', date: '2026-06-30' })
    // No merchant name and no original text: the description is the text.
    await book({ merchantName: '', description: 'Telia Sverige AB', category: 'expense_telecom', account: '6212' })
    // A merchant name wins over the bank's texts.
    await book({ merchantName: 'SL', originalDescription: 'KORTKÖP SL ACCESS', description: 'Resa', category: 'expense_travel', account: '5810' })
    // Texts that only say how it was paid name no one, and a one-letter key
    // is no identity: no pattern for any of these.
    await book({ originalDescription: 'INTERNET BET 4', description: 'INTERNET BET 4', category: 'expense_other', account: '4010' })
    await book({ originalDescription: 'Insättning', description: 'Insättning', category: 'expense_other', account: '4010' })
    await book({ originalDescription: 'Autogiro', description: 'Autogiro', category: 'expense_other', account: '4010' })
    await book({ originalDescription: 'J', description: 'J', category: 'expense_other', account: '4010' })
    // A bank text longer than any merchant name.
    await book({ originalDescription: LONG_TEXT, description: 'Butik', category: 'expense_other', account: '4010' })
  })

  it('builds patterns from original_description and description when merchant_name is empty', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const spotify = stats.counterparty_patterns.find((p) => p.counterparty_key === 'spotify')
    expect(spotify).toMatchObject({
      occurrences: 3,
      last_booked: '2026-06-30',
      dominant_category: 'expense_software',
      dominant_category_count: 3,
      dominant_account_number: '5420',
    })
    // Keyed on the immutable bank text, not the renamed working title.
    expect(stats.counterparty_patterns.find((p) => p.counterparty_key === 'musik')).toBeUndefined()

    const telia = stats.counterparty_patterns.find((p) => p.counterparty_key === 'telia sverige')
    expect(telia).toMatchObject({ counterparty: 'Telia Sverige AB', occurrences: 1, dominant_account_number: '6212' })

    const sl = stats.counterparty_patterns.find((p) => p.counterparty_key === 'sl')
    expect(sl).toMatchObject({ counterparty: 'SL', occurrences: 1, dominant_account_number: '5810' })
    expect(stats.counterparty_patterns.find((p) => p.counterparty_key.includes('access'))).toBeUndefined()
  })

  it('leaves out payment-method texts and keys shorter than two characters', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const keys = stats.counterparty_patterns.map((p) => p.counterparty_key)
    for (const raw of ['INTERNET BET 4', 'Insättning', 'Autogiro']) {
      expect(namesCounterparty(raw), raw).toBe(false)
      expect(keys).not.toContain(normalizeCounterpartyName(raw))
    }
    expect(keys).not.toContain('j')
    expect(keys.every((k) => k.length >= 2)).toBe(true)
  })

  it('returns the categorization_templates key, so the template join stays exact', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const byKey = new Map(stats.counterparty_patterns.map((p) => [p.counterparty_key, p]))
    for (const raw of ['KORTKÖP SPOTIFY AB 2026-05-01', 'Telia Sverige AB', 'SL', LONG_TEXT]) {
      expect(byKey.has(normalizeCounterpartyName(raw)), raw).toBe(true)
    }
  })

  it('cuts the display name at 60 characters and keeps the output shape', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const long = stats.counterparty_patterns.find(
      (p) => p.counterparty_key === normalizeCounterpartyName(LONG_TEXT),
    )
    expect(LONG_TEXT.length).toBeGreaterThan(60)
    expect(long!.counterparty).toBe(LONG_TEXT.slice(0, 60))
    expect(long!.occurrences).toBe(1)
    for (const p of stats.counterparty_patterns) {
      expect(Object.keys(p).sort()).toEqual([
        'counterparty', 'counterparty_key', 'dominant_account_number', 'dominant_category',
        'dominant_category_count', 'last_booked', 'occurrences',
      ])
      expect(p.counterparty.length).toBeLessThanOrEqual(60)
    }
  })
})

describe('imported_voucher_counterparty', () => {
  async function extract(raw: string | null): Promise<string | null> {
    const res = await getPool().query(`SELECT public.imported_voucher_counterparty($1) AS name`, [raw])
    return res.rows[0].name as string | null
  }

  it('takes the name out of the wrappers the previous systems write', async () => {
    expect(await extract('Levfakt Telia Sverige AB (1234)')).toBe('Telia Sverige AB')
    expect(await extract('LEVBET Foo (Nord) AB (12)')).toBe('Foo (Nord) AB')
    expect(await extract('Kundfaktura Acme Konsult AB (1005)')).toBe('Acme Konsult AB')
    expect(await extract('Leverantörsfaktura från 42 Kommunens Energi AB, 112233')).toBe('Kommunens Energi AB')
    expect(await extract('Betalning till 1234-5678 Hälsopartner AB, 900001')).toBe('Hälsopartner AB')
    expect(await extract('Kundfaktura till 17 Anna Exempel, 400100')).toBe('Anna Exempel')
    expect(await extract('Faktura 1001 Exempel Konsult AB')).toBe('Exempel Konsult AB')
    expect(await extract('LEVERANTÖRSFAKTURA: Elgrossist Nord AB - 100200 - Inköp varor 25% moms')).toBe('Elgrossist Nord AB')
  })

  it('keeps a bank-direct text as it stands and names no one for a bare wrapper', async () => {
    expect(await extract('ANTHROPIC* CLAUDE SUB')).toBe('ANTHROPIC* CLAUDE SUB')
    expect(await extract('Fakturaavgift Bank')).toBe('Fakturaavgift Bank')
    expect(await extract('Levfakt  (12)')).toBeNull()
    expect(await extract('Betalning Leverantörsfaktura V12')).toBeNull()
    expect(await extract('Faktura #5001 (OCR 9001)')).toBeNull()
    expect(await extract('Leverantörsfaktura: ')).toBeNull()
    expect(await extract('   ')).toBeNull()
    expect(await extract(null)).toBeNull()
  })
})

describe('get_ledger_usage_stats imported_counterparty_patterns', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string
  let voucher = 100

  async function imported(description: string, entryDate: string, lines: Array<[string, number, number]>): Promise<string> {
    return insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate, description,
      sourceType: 'import',
      voucherSeries: 'I',
      voucherNumber: voucher++,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })
  }

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    fiscalPeriodId = seeded.fiscalPeriodId

    // A company card on 2890: card-settled verifikat settle through money.
    await getPool().query(
      `INSERT INTO public.cash_accounts
         (id, company_id, ledger_account, currency, name, kind, card_issuer, card_last4,
          invoice_payee, is_primary, iban, source)
       VALUES ($1, $2, '2890', 'SEK', 'Företagskort', 'card', 'eurocard', ARRAY['3667'], false, false, NULL, 'manual')`,
      [randomUUID(), companyId],
    )

    // Supplier invoices through leverantörsreskontra, 25 % ingående moms.
    for (const [nr, date] of [['101', '2026-05-05'], ['102', '2026-06-05'], ['103', '2026-06-25']] as const) {
      await imported(`Levfakt Telia Sverige AB (${nr})`, date, [['6212', 800, 0], ['2641', 200, 0], ['2440', 0, 1000]])
    }
    // Their payments, one with an exchange difference: a payment says how a
    // debt was settled, never what was bought.
    await imported('Levbet Telia Sverige AB (101)', '2026-05-30', [['2440', 1000, 0], ['1930', 0, 1000]])
    await imported('Levbet Telia Sverige AB (102)', '2026-06-30', [['2440', 1000, 0], ['7960', 5, 0], ['1930', 0, 1005]])
    // Bank-direct reverse-charge purchase from abroad (2645/2614).
    await imported('ANTHROPIC* CLAUDE SUB SAN FRANCISCO', '2026-05-20', [['6540', 500, 0], ['2645', 125, 0], ['2614', 0, 125], ['1930', 0, 500]])
    await imported('ANTHROPIC* CLAUDE SUB', '2026-06-20', [['6540', 500, 0], ['2645', 125, 0], ['2614', 0, 125], ['1930', 0, 500]])
    // Sales through kundreskontra, 25 % utgående moms, and a customer payment.
    await imported('Kundfaktura Acme Konsult AB (5001)', '2026-05-10', [['1510', 1250, 0], ['3041', 0, 1000], ['2611', 0, 250]])
    await imported('Kundfaktura Acme Konsult AB (5002)', '2026-06-10', [['1510', 1250, 0], ['3041', 0, 1000], ['2611', 0, 250]])
    await imported('Kundbet Acme Konsult AB (5001)', '2026-06-01', [['1930', 1250, 0], ['1510', 0, 1250]])
    // Domestic reverse charge (byggtjänst, 2647/2614).
    await imported('Leverantörsfaktura från 77 Bygg Partner AB, F-123', '2026-05-12', [['4425', 1000, 0], ['2647', 250, 0], ['2614', 0, 250], ['2440', 0, 1000]])
    await imported('Leverantörsfaktura från 77 Bygg Partner AB, F-124', '2026-06-12', [['4425', 1000, 0], ['2647', 250, 0], ['2614', 0, 250], ['2440', 0, 1000]])
    // 2641 alone: the rate comes from the amounts (12 on 100 is 12 %).
    await imported('Restaurang Kungen', '2026-05-14', [['5831', 100, 0], ['2641', 12, 0], ['1930', 0, 112]])
    await imported('Restaurang Kungen', '2026-06-14', [['5831', 100, 0], ['2641', 12, 0], ['1930', 0, 112]])
    // Paid with the company card.
    await imported('SPOTIFY', '2026-05-16', [['6540', 100, 0], ['2641', 25, 0], ['2890', 0, 125]])
    await imported('SPOTIFY', '2026-06-16', [['6540', 100, 0], ['2641', 25, 0], ['2890', 0, 125]])
    // Import VAT legs: the account is known, the treatment is not.
    await imported('Leverantörsfaktura: Speditören AB - 991 - Import', '2026-05-18', [['4010', 1000, 0], ['2641', 250, 0], ['2615', 0, 250], ['2440', 0, 1000]])
    await imported('Leverantörsfaktura: Speditören AB - 992 - Import', '2026-06-18', [['4010', 1000, 0], ['2641', 250, 0], ['2615', 0, 250], ['2440', 0, 1000]])
    // Never patterns: an accrual (no money, no reskontra), a bare wrapper,
    // a verifikat before the window, and a reversed one.
    await imported('Periodisering hyra', '2026-06-30', [['1790', 500, 0], ['5010', 0, 500]])
    await imported('Levfakt  (55)', '2026-06-02', [['4010', 100, 0], ['2440', 0, 100]])
    await imported('Levfakt Gammal Leverantör AB (1)', '2026-02-01', [['4010', 100, 0], ['2440', 0, 100]])
    // Reversed as reverseEntry does it: a posted storno with reverses_id and
    // the lines swapped, then the original flipped to 'reversed'.
    const undone = await imported('Levfakt Ångrad AB (9)', '2026-06-03', [['6110', 100, 0], ['2440', 0, 100]])
    const reversal = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-04', 'Makulering', 'storno', 'draft', $6)`,
      [reversal, userId, companyId, fiscalPeriodId, voucher++, undone],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [reversal, undone],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [reversal])
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
      [undone, reversal],
    )
  })

  it('learns the booking account, VAT and settlement of each counterparty', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    // Ordered by verifikat count; the display-name tiebreak follows the
    // database collation, so compare the two-verifikat rows by key.
    expect(stats.imported_counterparty_patterns.map((p) => p.vouchers)).toEqual([3, 2, 2, 2, 2, 2, 2])
    const rows = stats.imported_counterparty_patterns
      .map((p) => [
        p.counterparty_key, p.vouchers, p.settled_via, p.dominant_account_number, p.dominant_account_count,
        p.vat_treatment, p.vat_treatment_count,
      ] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    expect(rows).toEqual([
      ['telia sverige', 3, 'payable', '6212', 3, 'standard_25', 3],
      ['acme konsult', 2, 'receivable', '3041', 2, 'standard_25', 2],
      ['anthropic', 2, 'bank', '6540', 2, 'reverse_charge', 2],
      ['bygg partner', 2, 'payable', '4425', 2, 'reverse_charge_domestic', 2],
      ['restaurang kungen', 2, 'bank', '5831', 2, 'reduced_12', 2],
      ['speditören', 2, 'payable', '4010', 2, null, 0],
      ['spotify', 2, 'bank', '6540', 2, 'standard_25', 2],
    ])
    const telia = stats.imported_counterparty_patterns[0]
    expect(telia.counterparty).toBe('Telia Sverige AB')
    expect(telia.last_booked).toBe('2026-06-25')
    // The most frequent raw text is the display name; ties go to the first.
    expect(stats.imported_counterparty_patterns.find((p) => p.counterparty_key === 'anthropic')!.counterparty)
      .toBe('ANTHROPIC* CLAUDE SUB')
  })

  it('never learns from payments, accruals, bare wrappers, the past window or reversed verifikat', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const accounts = stats.imported_counterparty_patterns.map((p) => p.dominant_account_number)
    expect(accounts).not.toContain('2440')
    expect(accounts).not.toContain('1510')
    expect(accounts).not.toContain('1930')
    expect(accounts).not.toContain('7960')
    expect(accounts).not.toContain('2890')
    const keys = stats.imported_counterparty_patterns.map((p) => p.counterparty_key)
    for (const absent of ['levfakt', 'periodisering hyra', 'gammal leverantör', 'ångrad']) {
      expect(keys.some((k) => k.includes(absent)), absent).toBe(false)
    }
    // A later window drops what was booked before it.
    const late = await callRpc(companyId, '2026-06-01')
    expect(late.imported_counterparty_patterns.find((p) => p.counterparty_key === 'telia sverige')!.vouchers).toBe(2)
  })

  it('keys an imported counterparty as a bank row and a template of it are keyed', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const keys = stats.imported_counterparty_patterns.map((p) => p.counterparty_key)
    for (const raw of ['Telia Sverige AB', 'ANTHROPIC* CLAUDE SUB', 'Bygg Partner AB', 'SPOTIFY']) {
      expect(keys).toContain(normalizeCounterpartyName(raw))
    }
    // Imports add no bank-row patterns, and the bank-row company has no
    // imported ones: the two bases are separate sections.
    expect(stats.counterparty_patterns).toEqual([])
  })

  it('isolates companies', async () => {
    const other = await seedCompany()
    const stats = await callRpc(other.companyId, '2026-04-01')
    expect(stats.imported_counterparty_patterns).toEqual([])
  })
})

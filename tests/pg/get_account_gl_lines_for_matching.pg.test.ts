/**
 * pg-real test for get_account_gl_lines_for_matching
 * (20260610120000_gl_lines_for_matching.sql, link-count semantics reworked in
 * 20260723160000_gl_lines_matching_account_scoped_count.sql).
 *
 * This RPC backs the N:1 "lägga på flera" feature: it mirrors get_unlinked_gl_lines
 * but can ALSO surface already-matched vouchers (so a second/third bank
 * transaction can be attached to one verifikat), each carrying how many
 * transactions already point at it.
 *
 * Since 20260723090000 the link count is scoped to the requested settlement
 * account: a transaction provably on ANOTHER cash account does not mark the
 * voucher as matched for p_account_number. This surfaces the unsettled second
 * leg of an own-account transfer by default (issue #1026) while transactions
 * with no resolvable cash account keep counting for every account.
 * (The companion mark_entry_as_opening_balance guard from the same migration
 * is covered in mark-entry-as-opening-balance.pg.test.ts.)
 */
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry as insertAtomicPostedJournalEntry,
  insertTransaction,
} from './fixtures'

async function insertPostedJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  sourceType: 'opening_balance' | 'manual' | 'bank_transaction' | 'import' | 'storno' | 'correction'
  voucherNumber: number
  amount?: number
  /** Line rows to book; defaults to the classic 1930 debit / 2091 credit pair. */
  lines?: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  const amount = params.amount ?? 1000
  const lines = params.lines ?? [
    { account: '1930', debit: amount, credit: 0 },
    { account: '2091', debit: 0, credit: amount },
  ]
  return insertAtomicPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
    entryDate: params.entryDate,
    description: `Test ${params.sourceType}`,
    sourceType: params.sourceType,
    lines: lines.map((line) => ({
      accountNumber: line.account,
      debitAmount: line.debit,
      creditAmount: line.credit,
    })),
  })
}

describe('get_account_gl_lines_for_matching RPC: N:1 candidates', () => {
  it('returns already-matched vouchers (with link count) only when p_include_matched is true', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })

    // One unmatched voucher, one voucher already settled by TWO transactions
    // (the salary-run-paid-in-two-transfers shape).
    const unmatchedEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-03-15', sourceType: 'bank_transaction', voucherNumber: 1, amount: 1500,
    })
    const matchedEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-03-20', sourceType: 'manual', voucherNumber: 2, amount: 30000,
    })
    await insertTransaction({ companyId, userId, currency: 'SEK', journalEntryId: matchedEntry })
    await insertTransaction({ companyId, userId, currency: 'SEK', journalEntryId: matchedEntry })

    // Default (p_include_matched=false): parity with get_unlinked_gl_lines: only
    // the unmatched voucher, count 0.
    const { rows: unmatchedOnly } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1)`,
      [companyId],
    )
    const unmatchedIds = new Set(unmatchedOnly.map((r) => r.journal_entry_id))
    expect(unmatchedIds.has(unmatchedEntry)).toBe(true)
    expect(unmatchedIds.has(matchedEntry)).toBe(false)
    expect(unmatchedOnly.find((r) => r.journal_entry_id === unmatchedEntry).linked_transaction_count).toBe(0)

    // p_include_matched=true: the matched voucher appears too, reporting both links.
    const { rows: withMatched } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_include_matched => true)`,
      [companyId],
    )
    const byId = new Map(withMatched.map((r) => [r.journal_entry_id, r.linked_transaction_count]))
    expect(byId.get(unmatchedEntry)).toBe(0)
    expect(byId.get(matchedEntry)).toBe(2)
  })

  it('still excludes opening_balance / storno / correction even with p_include_matched', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })

    // These book-only / IB vouchers have no bank-feed counterpart and can never
    // be a match target: the include_matched opt-in must not resurrect them.
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-01-01', sourceType: 'opening_balance', voucherNumber: 1, amount: 50000,
    })
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-02', sourceType: 'storno', voucherNumber: 2, amount: 25000,
    })
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-02', sourceType: 'correction', voucherNumber: 3, amount: 25000,
    })
    const bankEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-03', sourceType: 'bank_transaction', voucherNumber: 4, amount: 1500,
    })

    const { rows } = await getPool().query(
      `SELECT journal_entry_id, source_type
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_include_matched => true)`,
      [companyId],
    )

    const returnedIds = new Set(rows.map((r) => r.journal_entry_id))
    expect(returnedIds.has(bankEntry)).toBe(true)
    expect(rows.find((r) => r.source_type === 'opening_balance')).toBeUndefined()
    expect(rows.find((r) => r.source_type === 'storno')).toBeUndefined()
    expect(rows.find((r) => r.source_type === 'correction')).toBeUndefined()
  })
})

describe('get_account_gl_lines_for_matching RPC: account-scoped link count (#1026)', () => {
  it('surfaces the unsettled leg of an own-account transfer by default', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    await insertCashAccount({ companyId, ledgerAccount: '1930' })
    const acc1940 = await insertCashAccount({ companyId, ledgerAccount: '1940' })

    // Own-account transfer: one voucher, debit 1930 / credit 1940. The outgoing
    // leg (a transaction on the 1940 account) is already matched to it.
    const transferEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-26', sourceType: 'manual', voucherNumber: 1,
      lines: [
        { account: '1930', debit: 2344.16, credit: 0 },
        { account: '1940', debit: 0, credit: 2344.16 },
      ],
    })
    await insertTransaction({
      companyId, userId, amount: -2344.16, date: '2026-06-26',
      journalEntryId: transferEntry, cashAccountId: acc1940,
    })

    // From 1930's perspective the voucher is unmatched: it must appear in the
    // DEFAULT list (no toggle) with a zero link count, so ranking/auto-select
    // treat it as a normal candidate.
    const { rows: on1930 } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_account_number => '1930')`,
      [companyId],
    )
    const row1930 = on1930.find((r) => r.journal_entry_id === transferEntry)
    expect(row1930).toBeDefined()
    expect(row1930.linked_transaction_count).toBe(0)

    // From 1940's perspective it IS settled: hidden by default, visible with
    // the opt-in and carrying the link.
    const { rows: on1940Default } = await getPool().query(
      `SELECT journal_entry_id
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_account_number => '1940')`,
      [companyId],
    )
    expect(on1940Default.find((r) => r.journal_entry_id === transferEntry)).toBeUndefined()

    const { rows: on1940Matched } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(
           p_company_id => $1, p_account_number => '1940', p_include_matched => true)`,
      [companyId],
    )
    expect(on1940Matched.find((r) => r.journal_entry_id === transferEntry).linked_transaction_count).toBe(1)
  })

  it('keeps same-account N:1 vouchers behind the include_matched opt-in', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    const acc1930 = await insertCashAccount({ companyId, ledgerAccount: '1930' })

    // A salary-run shape: one voucher on 1930, partially settled by a first
    // transfer FROM THE SAME account. The second instalment must still require
    // the deliberate opt-in; account scoping must not open the N:1 floodgate.
    const salaryEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-25', sourceType: 'manual', voucherNumber: 1, amount: 30000,
    })
    await insertTransaction({
      companyId, userId, amount: -10000, date: '2026-06-25',
      journalEntryId: salaryEntry, cashAccountId: acc1930,
    })

    const { rows: byDefault } = await getPool().query(
      `SELECT journal_entry_id
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_account_number => '1930')`,
      [companyId],
    )
    expect(byDefault.find((r) => r.journal_entry_id === salaryEntry)).toBeUndefined()

    const { rows: withMatched } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(
           p_company_id => $1, p_account_number => '1930', p_include_matched => true)`,
      [companyId],
    )
    expect(withMatched.find((r) => r.journal_entry_id === salaryEntry).linked_transaction_count).toBe(1)
  })

  it('treats transactions without a resolvable cash account as settling every account', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })

    // Legacy shape: the linked transaction carries no cash_account_id, so it
    // could belong to any account. The voucher must stay hidden by default
    // (conservative: pre-account-scoping behavior).
    const legacyEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-20', sourceType: 'bank_transaction', voucherNumber: 1, amount: 500,
    })
    await insertTransaction({
      companyId, userId, amount: 500, date: '2026-06-20',
      journalEntryId: legacyEntry, cashAccountId: null,
    })

    const { rows: byDefault } = await getPool().query(
      `SELECT journal_entry_id
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_account_number => '1930')`,
      [companyId],
    )
    expect(byDefault.find((r) => r.journal_entry_id === legacyEntry)).toBeUndefined()

    const { rows: withMatched } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(
           p_company_id => $1, p_account_number => '1930', p_include_matched => true)`,
      [companyId],
    )
    expect(withMatched.find((r) => r.journal_entry_id === legacyEntry).linked_transaction_count).toBe(1)
  })
})

describe('gl-line candidate RPCs: vouchers settled through transaction_voucher_links', () => {
  /**
   * Both candidate RPCs used to decide "already settled?" from
   * transactions.journal_entry_id alone. A bank row coupled to several
   * verifikat (link_transaction_to_vouchers) leaves that scalar NULL by design,
   * so every verifikat settled that way kept surfacing as an omatchad
   * verifikation with no way for the user to make it go away, and
   * get_unlinked_gl_lines offered it to the auto-reconciler as a free candidate.
   * Covers 20260815093000.
   */
  async function seedSplitScenario() {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })

    // Two booked utlägg settled by ONE outgoing payment, plus an untouched
    // voucher that must stay a candidate.
    const jeA = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-01', sourceType: 'manual', voucherNumber: 1,
      lines: [{ account: '5460', debit: 5000, credit: 0 }, { account: '1930', debit: 0, credit: 5000 }],
    })
    const jeB = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-01', sourceType: 'manual', voucherNumber: 2,
      lines: [{ account: '5460', debit: 3000, credit: 0 }, { account: '1930', debit: 0, credit: 3000 }],
    })
    const jeFree = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-02', sourceType: 'manual', voucherNumber: 3,
      lines: [{ account: '5460', debit: 999, credit: 0 }, { account: '1930', debit: 0, credit: 999 }],
    })

    const txId = await insertTransaction({
      companyId, userId, amount: -8000, date: '2026-06-01',
    })

    // Write the links directly: this suite exercises the READ RPCs, and the
    // writer has its own coverage in link-transaction-to-vouchers.pg.test.ts.
    for (const [je, amount] of [[jeA, -5000], [jeB, -3000]] as const) {
      await getPool().query(
        `INSERT INTO public.transaction_voucher_links
           (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
         VALUES ($1, $2, $3, $4, $5, 'bank_line')`,
        [userId, companyId, txId, je, amount],
      )
    }

    return { companyId, jeA, jeB, jeFree }
  }

  it('drops link-settled vouchers from get_unlinked_gl_lines', async () => {
    const { companyId, jeA, jeB, jeFree } = await seedSplitScenario()

    const { rows } = await getPool().query(
      `SELECT journal_entry_id FROM public.get_unlinked_gl_lines($1, '1930')`,
      [companyId],
    )
    const ids = rows.map((r) => r.journal_entry_id)

    // This RPC feeds the auto-reconciler, which WRITES the matches it finds:
    // leaving a settled voucher here would let it be auto-linked a second time.
    expect(ids).not.toContain(jeA)
    expect(ids).not.toContain(jeB)
    expect(ids).toContain(jeFree)
  })

  it('counts a link-settled voucher as matched in get_account_gl_lines_for_matching', async () => {
    const { companyId, jeA, jeFree } = await seedSplitScenario()

    const { rows: defaultRows } = await getPool().query(
      `SELECT journal_entry_id
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_account_number => '1930')`,
      [companyId],
    )
    expect(defaultRows.map((r) => r.journal_entry_id)).toEqual([jeFree])

    const { rows: matchedRows } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(
           p_company_id => $1, p_account_number => '1930', p_include_matched => true)`,
      [companyId],
    )
    expect(matchedRows.find((r) => r.journal_entry_id === jeA).linked_transaction_count).toBe(1)
  })

  it('counts a transaction anchored by BOTH the scalar and a link only once', async () => {
    // The single-link case keeps transactions.journal_entry_id in sync with the
    // link row, so a naive count(*) over the union would report 2 and overstate
    // how settled the voucher is.
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })
    const je = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-01', sourceType: 'manual', voucherNumber: 1,
      lines: [{ account: '5460', debit: 5000, credit: 0 }, { account: '1930', debit: 0, credit: 5000 }],
    })
    const txId = await insertTransaction({
      companyId, userId, amount: -5000, date: '2026-06-01', journalEntryId: je,
    })
    await getPool().query(
      `INSERT INTO public.transaction_voucher_links
         (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, -5000, 'bank_line')`,
      [userId, companyId, txId, je],
    )

    const { rows } = await getPool().query(
      `SELECT linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(
           p_company_id => $1, p_account_number => '1930', p_include_matched => true)
        WHERE journal_entry_id = $2`,
      [companyId, je],
    )
    expect(rows[0].linked_transaction_count).toBe(1)
  })
})

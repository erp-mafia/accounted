/**
 * pg-real test for get_vat_declaration_totals.
 *
 * The RPC backs the momsdeklaration and the settlement proposal: one SQL
 * pass returns per-account totals, settlement-shaped entries, and per-
 * source_type entry counts. The settlement-shape exclusion (#984) used to
 * live in JS (lib/reports/vat-declaration.ts) with mocked-client unit
 * tests; the behavior now lives here, against real Postgres:
 *
 *   - tagged vat_settlement entries never reach the totals;
 *   - an untagged entry touching BOTH a declaration account and 2650/1650
 *     is "shaped": excluded from totals, surfaced in
 *     settlement_shaped_entries;
 *   - opening-balance entries are exempt from shaping (carried-in 26xx
 *     balances are unsettled VAT);
 *   - a plain 2650 payment (no declaration account) is NOT shaped;
 *   - source_type_counts covers all posted/reversed entries in the period,
 *     including tagged settlements.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'

// Mirrors the TS call site (lib/reports/vat-declaration.ts): a small
// representative slice of ACCOUNT_RUTA is enough since the full list is a
// parameter, not baked into the SQL.
const RUTA_ACCOUNTS = ['2611', '2618', '2621', '2641', '2645', '2648', '3001']
const NET_ACCOUNTS = ['2650', '1650']
const ALL_ACCOUNTS = [...RUTA_ACCOUNTS, ...NET_ACCOUNTS]
// This account keeps intentionally narrow VAT fixtures balanced without
// entering the account set asserted by this read-side RPC suite.
const VAT_FIXTURE_BALANCING_ACCOUNT = '2999'

interface RpcPayload {
  totals: Array<{ account_number: string; debit: number; credit: number }>
  settlement_shaped_entries: Array<{
    id: string
    status: string
    entry_date: string
    source_type: string | null
    voucher_series: string | null
    voucher_number: number | null
  }>
  source_type_counts: Record<string, number>
}

async function callRpc(
  companyId: string,
  start = '2026-01-01',
  end = '2026-12-31',
): Promise<RpcPayload> {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1, $2, $3, $4, $5, $6) AS payload`,
    [companyId, start, end, ALL_ACCOUNTS, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  return rows[0].payload as RpcPayload
}

function totalsByAccount(payload: RpcPayload) {
  return new Map(payload.totals.map((t) => [t.account_number, t]))
}

async function insertJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  status?: 'draft' | 'posted' | 'reversed'
  sourceType?: string
  entryDate?: string
  description?: string
  lines: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  if ((params.status ?? 'posted') === 'posted') {
    return insertPostedJournalEntry({
      userId: params.userId,
      companyId: params.companyId,
      fiscalPeriodId: params.fiscalPeriodId,
      voucherNumber: params.voucherNumber,
      entryDate: params.entryDate ?? '2026-03-15',
      description: params.description ?? 'VAT RPC test',
      sourceType: params.sourceType ?? 'manual',
      lines: params.lines.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
  }

  const id = randomUUID()
  // Insert directly, bypassing commit_journal_entry's voucher sequencing —
  // fine for a read-side RPC that only aggregates line/account references.
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, 'VAT RPC test', $7, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber,
      params.entryDate ?? '2026-03-15',
      params.sourceType ?? 'manual',
      params.status ?? 'posted',
    ],
  )
  for (const line of params.lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [id, line.account, line.debit, line.credit],
    )
  }
  return id
}

async function seedCompany() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  return { userId, companyId, fiscalPeriodId }
}

describe('get_vat_declaration_totals RPC', () => {
  it('aggregates per-account debit/credit sums for posted entries', async () => {
    const ctx = await seedCompany()

    await insertJournalEntry({
      ...ctx, voucherNumber: 1, sourceType: 'invoice_created',
      lines: [
        { account: '3001', debit: 0, credit: 10000 },
        { account: '2611', debit: 0, credit: 2500 },
        { account: '1930', debit: 12500, credit: 0 },
      ],
    })
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, sourceType: 'bank_transaction',
      lines: [
        { account: '2641', debit: 250, credit: 0 },
        { account: '1930', debit: 0, credit: 1250 },
        { account: '6110', debit: 1000, credit: 0 },
      ],
    })

    const payload = await callRpc(ctx.companyId)
    const totals = totalsByAccount(payload)

    expect(totals.get('3001')).toMatchObject({ debit: 0, credit: 10000 })
    expect(totals.get('2611')).toMatchObject({ debit: 0, credit: 2500 })
    expect(totals.get('2641')).toMatchObject({ debit: 250, credit: 0 })
    // Non-VAT accounts (1930, 6110) never appear: they are outside p_accounts.
    expect(totals.has('1930')).toBe(false)
    expect(totals.has('6110')).toBe(false)
    expect(payload.settlement_shaped_entries).toEqual([])
    expect(payload.source_type_counts).toEqual({
      invoice_created: 1,
      bank_transaction: 1,
    })
  })

  it('excludes draft entries and entries outside the period', async () => {
    const ctx = await seedCompany()

    await insertJournalEntry({
      ...ctx, voucherNumber: 1, status: 'draft',
      lines: [{ account: '2611', debit: 0, credit: 999 }],
    })
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, entryDate: '2025-12-31',
      lines: [
        { account: '2611', debit: 0, credit: 777 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 777, credit: 0 },
      ],
    })
    await insertJournalEntry({
      ...ctx, voucherNumber: 3, entryDate: '2026-06-30',
      lines: [
        { account: '2611', debit: 0, credit: 100 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 100, credit: 0 },
      ],
    })

    const payload = await callRpc(ctx.companyId, '2026-01-01', '2026-12-31')
    expect(totalsByAccount(payload).get('2611')).toMatchObject({ debit: 0, credit: 100 })
    expect(payload.source_type_counts).toEqual({ manual: 1 })
  })

  it('excludes tagged vat_settlement entries from totals without shaping them', async () => {
    const ctx = await seedCompany()

    await insertJournalEntry({
      ...ctx, voucherNumber: 1, sourceType: 'invoice_created',
      lines: [
        { account: '2611', debit: 0, credit: 2500 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 2500, credit: 0 },
      ],
    })
    // The app's own settlement flow: tagged, filtered by source_type alone.
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, sourceType: 'vat_settlement',
      lines: [
        { account: '2611', debit: 2500, credit: 0 },
        { account: '2650', debit: 0, credit: 2500 },
      ],
    })

    const payload = await callRpc(ctx.companyId)
    expect(totalsByAccount(payload).get('2611')).toMatchObject({ debit: 0, credit: 2500 })
    expect(payload.settlement_shaped_entries).toEqual([])
    // The metadata scan always counted tagged settlements: preserved.
    expect(payload.source_type_counts).toEqual({
      invoice_created: 1,
      vat_settlement: 1,
    })
  })

  it('shapes an untagged manual momsomföring: excluded from totals, surfaced for gating (#984)', async () => {
    const ctx = await seedCompany()

    await insertJournalEntry({
      ...ctx, voucherNumber: 1, sourceType: 'invoice_created',
      lines: [
        { account: '2611', debit: 0, credit: 2500 },
        { account: '2641', debit: 1000, credit: 0 },
        { account: '3001', debit: 0, credit: 10000 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 11500, credit: 0 },
      ],
    })
    // Manual settlement clearing the period to 2650, booked without the
    // vat_settlement source_type (e.g. before #980 shipped).
    const shapedId = await insertJournalEntry({
      ...ctx, voucherNumber: 2, sourceType: 'manual', entryDate: '2026-03-31',
      lines: [
        { account: '2611', debit: 2500, credit: 0 },
        { account: '2641', debit: 0, credit: 1000 },
        { account: '2650', debit: 0, credit: 1500 },
      ],
    })

    const payload = await callRpc(ctx.companyId)
    const totals = totalsByAccount(payload)

    // Without the shape exclusion every ruta reads 0 after the settlement.
    expect(totals.get('2611')).toMatchObject({ debit: 0, credit: 2500 })
    expect(totals.get('2641')).toMatchObject({ debit: 1000, credit: 0 })
    expect(totals.get('3001')).toMatchObject({ debit: 0, credit: 10000 })
    // The shaped entry's 2650 line is excluded along with the rest of it.
    expect(totals.has('2650')).toBe(false)

    expect(payload.settlement_shaped_entries).toHaveLength(1)
    expect(payload.settlement_shaped_entries[0]).toMatchObject({
      id: shapedId,
      status: 'posted',
      source_type: 'manual',
      voucher_series: 'A',
      voucher_number: 2,
    })
  })

  it('shapes a storno of a settlement so annullera never re-inflates the rutor', async () => {
    const ctx = await seedCompany()

    await insertJournalEntry({
      ...ctx, voucherNumber: 1, sourceType: 'invoice_created',
      lines: [
        { account: '2611', debit: 0, credit: 100 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 100, credit: 0 },
      ],
    })
    // The tagged settlement itself is filtered by source_type; its storno
    // reversal is untagged and would otherwise re-credit 2611.
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, sourceType: 'storno',
      lines: [
        { account: '2611', debit: 0, credit: 100 },
        { account: '2650', debit: 100, credit: 0 },
      ],
    })

    const payload = await callRpc(ctx.companyId)
    expect(totalsByAccount(payload).get('2611')).toMatchObject({ debit: 0, credit: 100 })
    expect(payload.settlement_shaped_entries).toHaveLength(1)
    expect(payload.settlement_shaped_entries[0]).toMatchObject({ source_type: 'storno' })
  })

  it('keeps opening-balance entries: carried-in 26xx balances are unsettled VAT', async () => {
    const ctx = await seedCompany()

    // Migrating company: undeclared input VAT and a prior VAT debt carried
    // in through the same opening-balance entry. Touches both a declaration
    // account and 2650, but the shape rule exempts opening balances.
    await insertJournalEntry({
      ...ctx, voucherNumber: 1, sourceType: 'opening_balance', entryDate: '2026-01-01',
      lines: [
        { account: '2641', debit: 500, credit: 0 },
        { account: '2650', debit: 0, credit: 300 },
        { account: '1930', debit: 0, credit: 200 },
      ],
    })

    const payload = await callRpc(ctx.companyId)
    const totals = totalsByAccount(payload)
    expect(totals.get('2641')).toMatchObject({ debit: 500, credit: 0 })
    expect(totals.get('2650')).toMatchObject({ debit: 0, credit: 300 })
    expect(payload.settlement_shaped_entries).toEqual([])
  })

  it('does not shape a plain VAT payment on 2650 (no declaration account touched)', async () => {
    const ctx = await seedCompany()

    await insertJournalEntry({
      ...ctx, voucherNumber: 1, sourceType: 'invoice_created',
      lines: [
        { account: '2611', debit: 0, credit: 100 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 100, credit: 0 },
      ],
    })
    // Paying last period's VAT debt: 2650 against the bank account.
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, sourceType: 'bank_transaction',
      lines: [
        { account: '2650', debit: 75, credit: 0 },
        { account: '1930', debit: 0, credit: 75 },
      ],
    })

    const payload = await callRpc(ctx.companyId)
    const totals = totalsByAccount(payload)
    expect(totals.get('2611')).toMatchObject({ debit: 0, credit: 100 })
    expect(totals.get('2650')).toMatchObject({ debit: 75, credit: 0 })
    expect(payload.settlement_shaped_entries).toEqual([])
  })

  it('includes the cash-method cut-off but excludes its day-one reversal', async () => {
    const ctx = await seedCompany()

    await insertJournalEntry({
      ...ctx,
      voucherNumber: 1,
      sourceType: 'year_end',
      description: 'Kundfordringar vid bokslut (kontantmetoden)',
      lines: [
        { account: '2618', debit: 0, credit: 250 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 250, credit: 0 },
      ],
    })
    await insertJournalEntry({
      ...ctx,
      voucherNumber: 2,
      sourceType: 'year_end',
      description: 'Vändning kundfordringar bokslut (kontantmetoden)',
      lines: [
        { account: '2618', debit: 250, credit: 0 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 0, credit: 250 },
      ],
    })

    const payload = await callRpc(ctx.companyId)
    expect(totalsByAccount(payload).get('2618')).toMatchObject({ debit: 0, credit: 250 })
    expect(payload.source_type_counts).toEqual({ year_end: 2 })
  })

  it('scopes everything to the requested company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    await insertJournalEntry({
      ...a, voucherNumber: 1,
      lines: [
        { account: '2611', debit: 0, credit: 100 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 100, credit: 0 },
      ],
    })
    await insertJournalEntry({
      ...b, voucherNumber: 1,
      lines: [
        { account: '2611', debit: 0, credit: 999 },
        { account: VAT_FIXTURE_BALANCING_ACCOUNT, debit: 999, credit: 0 },
      ],
    })

    const payload = await callRpc(a.companyId)
    expect(totalsByAccount(payload).get('2611')).toMatchObject({ debit: 0, credit: 100 })
    expect(payload.source_type_counts).toEqual({ manual: 1 })
  })

  it('returns empty sections for a company without entries', async () => {
    const ctx = await seedCompany()
    const payload = await callRpc(ctx.companyId)
    expect(payload.totals).toEqual([])
    expect(payload.settlement_shaped_entries).toEqual([])
    expect(payload.source_type_counts).toEqual({})
  })
})

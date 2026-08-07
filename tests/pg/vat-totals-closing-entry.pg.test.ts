/**
 * pg-real test for get_vat_declaration_totals: the resultatavslut must not
 * reach a momsdeklaration.
 *
 * The closing verifikat posts the mirror image of every P&L account into 2099
 * inside the same fiscal period. Revenue accounts drive rutor 05, 39 and 40, so
 * before migration 20260729110000 any VAT period containing the fiscal-year end
 * reported NEGATED turnover once the year was closed. On a production ledger
 * that produced ruta 39 = -794 734 kr for the December period of a closed year.
 *
 * Pinned here:
 *   - a POSTED closing entry linked from fiscal_periods.closing_entry_id is
 *     dropped, so the closing month reports nothing;
 *   - the month with the real sale is untouched;
 *   - a REVERSED closing entry is RETAINED together with its storno, so the
 *     pair still nets to zero (same predicate as closingEntry: 'exclude-final'
 *     in lib/reports/trial-balance.ts). Dropping only the reversed original
 *     would leave the storno behind and negate turnover a second time;
 *   - an ordinary year_end entry that is NOT the linked closing entry stays,
 *     because avskrivningar, periodiseringsfond and skatt share that
 *     source_type;
 *   - the pre-existing vat_settlement exclusion still holds.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from './fixtures'

// Mirrors the arrays lib/reports/vat-declaration.ts passes in.
//
// p_ruta_accounts is the fixed ACCOUNT_RUTA key set, which holds revenue AND
// VAT accounts. p_net_accounts is VAT_SETTLEMENT_NET_ACCOUNTS, the
// momsredovisning settlement pair 2650/1650, and it is NOT the output-VAT
// accounts: an entry carrying a line in p_ruta_accounts AND one in
// p_net_accounts is classified a momsredovisning by SHAPE and dropped from the
// totals entirely. An earlier draft put 2611 in p_net_accounts, which made an
// ordinary sale-with-VAT look like a settlement and silently vanish.
const RUTA_ACCOUNTS = ['3001', '3308', '2611', '2641']
const NET_ACCOUNTS = ['2650', '1650']
const ALL_ACCOUNTS = [...RUTA_ACCOUNTS, ...NET_ACCOUNTS]

interface Totals {
  totals: Array<{ account_number: string; debit: number; credit: number }>
  source_type_counts: Record<string, number>
}

async function callRpc(companyId: string, start: string, end: string): Promise<Totals> {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1, $2, $3, $4, $5, $6) AS payload`,
    [companyId, start, end, ALL_ACCOUNTS, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  return rows[0].payload as Totals
}

/** Net credit on an account, the orientation a revenue ruta reports. */
function netCredit(payload: Totals, account: string): number {
  const row = payload.totals.find((t) => t.account_number === account)
  if (!row) return 0
  return Number(row.credit) - Number(row.debit)
}

async function insertEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  entryDate: string
  status?: 'posted' | 'reversed'
  sourceType?: string
  reversesId?: string | null
  lines: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  const id = randomUUID()
  const status = params.status ?? 'posted'
  const client = await getPool().connect()
  // Inserted directly, bypassing commit_journal_entry's voucher sequencing:
  // this is a read-side aggregate that only reads lines and account numbers.
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'VAT closing-entry test', $7, $8, $9)`,
      [
        id,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.voucherNumber,
        params.entryDate,
        params.sourceType ?? 'manual',
        status,
        params.reversesId ?? null,
      ],
    )
    for (const line of params.lines) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4)`,
        [id, line.account, line.debit, line.credit],
      )
    }
    if (status === 'posted') {
      await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    }
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * One EU-services sale in January, then a December resultatavslut that debits
 * the same revenue account: the shape that produced the production bug.
 */
async function seedClosedYear(closingStatus: 'posted' | 'reversed') {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  // Left OPEN deliberately. enforce_period_lock (migration 017, legally
  // required) refuses any write into a closed period, so seeding entries into
  // one is impossible by design and must not be worked around. The RPC's
  // predicate keys on fiscal_periods.closing_entry_id and never reads
  // is_closed, so linking the closing entry below exercises the exact path
  // that matters without fighting a compliance trigger.
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    isClosed: false,
  })
  const ctx = { userId, companyId, fiscalPeriodId }

  await insertEntry({
    ...ctx,
    voucherNumber: 1,
    entryDate: '2026-01-16',
    sourceType: 'bank_transaction',
    lines: [
      { account: '1930', debit: 800_000, credit: 0 },
      { account: '3308', debit: 0, credit: 800_000 },
    ],
  })

  const closingEntryId = await insertEntry({
    ...ctx,
    voucherNumber: 2,
    entryDate: '2026-12-31',
    sourceType: 'year_end',
    status: closingStatus,
    lines: [
      { account: '3308', debit: 800_000, credit: 0 },
      { account: '2099', debit: 0, credit: 800_000 },
    ],
  })
  await getPool().query(
    `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
    [closingEntryId, fiscalPeriodId],
  )

  return { ...ctx, closingEntryId }
}

describe('get_vat_declaration_totals: year-end closing entry', () => {
  it('drops a posted resultatavslut from the closing month', async () => {
    const { companyId } = await seedClosedYear('posted')

    const december = await callRpc(companyId, '2026-12-01', '2026-12-31')

    // The regression: this reported -800 000 before the fix.
    expect(netCredit(december, '3308')).toBe(0)
  })

  it('leaves the month with the real sale untouched', async () => {
    const { companyId } = await seedClosedYear('posted')

    const january = await callRpc(companyId, '2026-01-01', '2026-01-31')

    expect(netCredit(january, '3308')).toBe(800_000)
  })

  it('reports the full year once, not zero, across the whole period', async () => {
    const { companyId } = await seedClosedYear('posted')

    const wholeYear = await callRpc(companyId, '2026-01-01', '2026-12-31')

    // With the closing entry in, sale and reversal cancelled to 0.
    expect(netCredit(wholeYear, '3308')).toBe(800_000)
  })

  it('keeps a reversed closing entry so it still nets against its storno', async () => {
    const { companyId, fiscalPeriodId, closingEntryId, userId } =
      await seedClosedYear('reversed')

    // Undo year-end: the closing entry is reversed and a posted storno mirrors
    // it. Both must be counted, or the storno alone negates turnover again.
    await insertEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: 3,
      entryDate: '2026-12-31',
      sourceType: 'storno',
      reversesId: closingEntryId,
      lines: [
        { account: '3308', debit: 0, credit: 800_000 },
        { account: '2099', debit: 800_000, credit: 0 },
      ],
    })

    const december = await callRpc(companyId, '2026-12-01', '2026-12-31')

    // Reversed original (-800 000) + storno (+800 000) = 0.
    expect(netCredit(december, '3308')).toBe(0)
  })

  it('keeps year_end entries that are not the linked closing entry', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedClosedYear('posted')

    // A bokslut entry sharing source_type 'year_end' but carrying real VAT.
    await insertEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: 4,
      entryDate: '2026-12-30',
      sourceType: 'year_end',
      lines: [
        { account: '3001', debit: 0, credit: 10_000 },
        { account: '2611', debit: 0, credit: 2_500 },
        { account: '1930', debit: 12_500, credit: 0 },
      ],
    })

    const december = await callRpc(companyId, '2026-12-01', '2026-12-31')

    expect(netCredit(december, '3001')).toBe(10_000)
    expect(netCredit(december, '2611')).toBe(2_500)
  })

  it('still excludes vat_settlement entries', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedClosedYear('posted')

    await insertEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: 5,
      entryDate: '2026-01-20',
      sourceType: 'vat_settlement',
      lines: [
        { account: '2611', debit: 5_000, credit: 0 },
        { account: '1930', debit: 0, credit: 5_000 },
      ],
    })

    const january = await callRpc(companyId, '2026-01-01', '2026-01-31')

    expect(netCredit(january, '2611')).toBe(0)
  })
})

/**
 * pg-real coverage for
 * 20261125120000_bind_booked_bank_rows_to_their_cash_account.sql (#1299).
 *
 * A booked bank row with no cash account is claimed by the primary cash
 * account, even when its verifikat books the money on another one. The
 * primary account then counts the row on its bank side with nothing on its
 * ledger side, and the account it was booked on misses it: two differences
 * with no unmatched row to click. The migration binds such a row to the
 * account its verifikat's single bank line names. Guards under test:
 *   - the reconciliation of both accounts agrees with their ledgers after it;
 *   - a transfer between two of the company's accounts (two bank lines) and
 *     a row booked on the primary account keep their NULL;
 *   - a row in another currency than the account keeps its NULL;
 *   - a row the binding guard refuses keeps its NULL and stops nothing else;
 *   - a re-run is a no-op.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from './fixtures'

const BACKFILL_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261125120000_bind_booked_bank_rows_to_their_cash_account.sql'),
  'utf8',
)

interface Books {
  userId: string
  companyId: string
  periodId: string
  primary: string
  savings: string
}

async function books(): Promise<Books> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const periodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    name: '2026',
  })
  const primary = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
  const savings = await insertCashAccount({ companyId, ledgerAccount: '1940' })
  return { userId, companyId, periodId, primary, savings }
}

/** A posted verifikat with the given [account, debit, credit] lines. */
async function verifikat(b: Books, date: string, lines: Array<[string, number, number]>): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
          description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Verifikat', 'manual', 'draft')`,
      [id, b.userId, b.companyId, b.periodId, date],
    )
    for (const [i, [account, debit, credit]] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, account, debit, credit, i],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * A bank row booked on `entry` with no cash account, as rows booked before
 * the writers bound at ingest were left. Today's binding guard refuses to
 * create one that points at a verifikat off 1930, so the legacy state is
 * written with the row triggers off.
 */
async function legacyBankRow(
  b: Books,
  entry: string,
  amount: number,
  currency = 'SEK',
): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL session_replication_role = replica`)
    await client.query(
      `INSERT INTO public.transactions
         (id, company_id, user_id, currency, amount, date, description, journal_entry_id,
          cash_account_id, category)
       VALUES ($1, $2, $3, $4, $5, '2026-06-10', 'Legacy row', $6, NULL, 'uncategorized')`,
      [id, b.companyId, b.userId, currency, amount, entry],
    )
    await client.query('COMMIT')
    return id
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function cashAccountOf(transactionId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ cash_account_id: string | null }>(
    `SELECT cash_account_id FROM public.transactions WHERE id = $1`,
    [transactionId],
  )
  return rows[0].cash_account_id
}

interface Facts {
  gl: { balance: number }
  bank: { total: number; unmatched_count: number }
}

/** The bank status' facts for one cash account over 2026, as the app asks for them. */
async function facts(b: Books, account: '1930' | '1940'): Promise<{ bank: number; ledger: number; unmatched: number }> {
  const cash = account === '1930' ? b.primary : b.savings
  const { rows } = await getPool().query<{ f: Facts }>(
    `SELECT public.get_bank_reconciliation_facts($1, $2, 'SEK', $3, $4, '2026-01-01', '2026-12-31') AS f`,
    [b.companyId, account, cash, account === '1930'],
  )
  const f = rows[0].f
  return { bank: Number(f.bank.total), ledger: Number(f.gl.balance), unmatched: Number(f.bank.unmatched_count) }
}

async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

describe('bind_booked_bank_rows_to_their_cash_account', () => {
  it('a row booked on the savings account leaves no difference on either account', async () => {
    const b = await books()
    const entry = await verifikat(b, '2026-06-10', [
      ['1940', 500, 0],
      ['3001', 0, 500],
    ])
    const row = await legacyBankRow(b, entry, 500)

    await runBackfill()

    expect(await facts(b, '1930')).toEqual({ bank: 0, ledger: 0, unmatched: 0 })
    expect(await facts(b, '1940')).toEqual({ bank: 500, ledger: 500, unmatched: 0 })
    expect(await cashAccountOf(row)).toBe(b.savings)
  })

  it('leaves a transfer between own accounts, a row on the primary and a row in another currency alone', async () => {
    const b = await books()
    const transfer = await verifikat(b, '2026-06-10', [
      ['1940', 300, 0],
      ['1930', 0, 300],
    ])
    const onPrimary = await verifikat(b, '2026-06-10', [
      ['1930', 200, 0],
      ['3001', 0, 200],
    ])
    const onSavings = await verifikat(b, '2026-06-10', [
      ['1940', 100, 0],
      ['3001', 0, 100],
    ])
    const transferRow = await legacyBankRow(b, transfer, 300)
    const primaryRow = await legacyBankRow(b, onPrimary, 200)
    const euroRow = await legacyBankRow(b, onSavings, 100, 'EUR')

    await runBackfill()

    expect(await cashAccountOf(transferRow)).toBeNull()
    expect(await cashAccountOf(primaryRow)).toBeNull()
    expect(await cashAccountOf(euroRow)).toBeNull()
  })

  it('keeps a row the binding guard refuses NULL and still binds the others', async () => {
    const b = await books()
    // The bank row is money in, the verifikat credits 1940: it does not book
    // this row's direction on the account, so the guard refuses the binding.
    const wrongWay = await verifikat(b, '2026-06-10', [
      ['3001', 400, 0],
      ['1940', 0, 400],
    ])
    const rightWay = await verifikat(b, '2026-06-10', [
      ['1940', 250, 0],
      ['3001', 0, 250],
    ])
    const refused = await legacyBankRow(b, wrongWay, 400)
    const bound = await legacyBankRow(b, rightWay, 250)

    await runBackfill()

    expect(await cashAccountOf(refused)).toBeNull()
    expect(await cashAccountOf(bound)).toBe(b.savings)
  })

  it('is a no-op on a second run', async () => {
    const b = await books()
    const entry = await verifikat(b, '2026-06-10', [
      ['1940', 80, 0],
      ['3001', 0, 80],
    ])
    const row = await legacyBankRow(b, entry, 80)
    await runBackfill()
    const { rows: before } = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.transactions WHERE id = $1`,
      [row],
    )

    await runBackfill()

    const { rows: after } = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.transactions WHERE id = $1`,
      [row],
    )
    expect(await cashAccountOf(row)).toBe(b.savings)
    expect(after[0].updated_at).toBe(before[0].updated_at)
  })
})

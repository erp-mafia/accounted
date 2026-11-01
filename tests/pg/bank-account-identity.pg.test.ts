/**
 * One bank account, one identity. Two cash_accounts rows are the same bank
 * account when their normalized IBAN and currency match: the ingest guard
 * always said so, the booking guard compared row ids, so a reconnect twin
 * (1930 and 1940 on one IBAN) hid a booked copy of the same movement.
 */
import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPool } from './setup'
import { createPgRest } from './postgrest-over-pg'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
} from './fixtures'
import { detectBookedDuplicateTransaction } from '@/lib/transactions/booking-duplicate-detection'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

function clientFor(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

const IBAN = 'SE4550000000058398257466'

async function books() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = $2`,
    [userId, companyId],
  )
  const period = await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31', name: '2026' })
  return { userId, companyId, period, client: clientFor(userId) }
}

async function twins() {
  const b = await books()
  const first = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1930', iban: IBAN, isPrimary: true })
  const twin = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1940', iban: IBAN })
  return { ...b, first, twin }
}

const booked = (b: Awaited<ReturnType<typeof twins>>, ledger: string) =>
  insertPostedJournalEntry({
    userId: b.userId,
    companyId: b.companyId,
    fiscalPeriodId: b.period,
    entryDate: '2026-03-10',
    lines: [
      { accountNumber: ledger, debitAmount: 0, creditAmount: 345.5 },
      { accountNumber: '6110', debitAmount: 345.5, creditAmount: 0 },
    ],
  })

describe('the booking guard reads one bank account', () => {
  it('finds a booked copy of the movement on the twin row', async () => {
    const b = await twins()
    const entry = await booked(b, '1930')
    const stored = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-03-10', amount: -345.5, cashAccountId: b.first, journalEntryId: entry })
    const target = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-03-10', amount: -345.5, cashAccountId: b.twin })

    const hit = await detectBookedDuplicateTransaction(b.client, b.companyId, {
      id: target, date: '2026-03-10', amount: -345.5, currency: 'SEK', cash_account_id: b.twin,
    } as never)
    expect(hit?.transaction_id).toBe(stored)
  }, 30000)

  it('two accounts with their own IBANs stay two accounts', async () => {
    const b = await books()
    const first = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1930', iban: IBAN, isPrimary: true })
    const other = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1940', iban: 'SE7280000810340009783242' })
    const entry = await insertPostedJournalEntry({
      userId: b.userId,
      companyId: b.companyId,
      fiscalPeriodId: b.period,
      entryDate: '2026-03-10',
      lines: [{ accountNumber: '1930', debitAmount: 0, creditAmount: 345.5 }, { accountNumber: '6110', debitAmount: 345.5, creditAmount: 0 }],
    })
    await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-03-10', amount: -345.5, cashAccountId: first, journalEntryId: entry })
    const target = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-03-10', amount: -345.5, cashAccountId: other })

    const hit = await detectBookedDuplicateTransaction(b.client, b.companyId, {
      id: target, date: '2026-03-10', amount: -345.5, currency: 'SEK', cash_account_id: other,
    } as never)
    expect(hit).toBeNull()
  }, 30000)
})

describe('the reconciliation rail keeps the account with the bookkeeping history', () => {
  async function rail(b: Awaited<ReturnType<typeof twins>>) {
    const accounts = await listReconciliationAccounts(b.client, b.companyId, { today: '2026-11-01', withStatus: false })
    return accounts.filter((a) => a.kind === 'bank').map((a) => ({ ledger: a.account_number, superseded: a.superseded_by !== null }))
  }

  it('folds away the row without history, however new it is', async () => {
    const b = await twins()
    await booked(b, '1930')
    // A balance refresh moves updated_at: liveness says nothing about history.
    await getPool().query(`UPDATE public.cash_accounts SET balance = 100 WHERE id = $1`, [b.twin])
    expect(await rail(b)).toEqual([{ ledger: '1930', superseded: false }, { ledger: '1940', superseded: true }])
  }, 30000)

  it('folds away neither row of an account split over two ledgers', async () => {
    const b = await twins()
    await booked(b, '1930')
    await booked(b, '1940')
    expect(await rail(b)).toEqual([{ ledger: '1930', superseded: false }, { ledger: '1940', superseded: false }])
  }, 30000)

  it('reads a spaced IBAN as the same account', async () => {
    const b = await books()
    await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1930', iban: IBAN, isPrimary: true })
    const spaced = 'se45 5000 0000 0583 9825 7466'
    const id = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1940', iban: spaced })
    await getPool().query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [id, spaced])
    const accounts = await listReconciliationAccounts(b.client, b.companyId, { today: '2026-11-01', withStatus: false })
    expect(accounts.filter((a) => a.kind === 'bank' && a.superseded_by !== null)).toHaveLength(1)
  }, 30000)
})

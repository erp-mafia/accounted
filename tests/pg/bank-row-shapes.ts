/**
 * The bank row shapes tests/pg/bank-row-anchors.pg.test.ts and
 * tests/pg/bank-row-open-read.pg.test.ts run through the database and through
 * every door: each shape states what the one answer is.
 */
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPool } from './setup'
import { createPgRest } from './postgrest-over-pg'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedBankJournalEntry,
  insertPostedJournalEntry,
  insertTransaction,
} from './fixtures'

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

export interface Books {
  userId: string
  companyId: string
  period: string
  cash: string
  client: SupabaseClient
}

export const DATE = '2026-03-10'

export async function books(): Promise<Books> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = $2`,
    [userId, companyId],
  )
  const period = await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31', name: '2026' })
  const cash = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK', isPrimary: true })
  return { userId, companyId, period, cash, client: clientFor(userId) }
}

export function bankLines(amount: number, account = '1930') {
  return amount >= 0
    ? [{ accountNumber: account, debitAmount: amount, creditAmount: 0 }, { accountNumber: '3001', debitAmount: 0, creditAmount: amount }]
    : [{ accountNumber: account, debitAmount: 0, creditAmount: -amount }, { accountNumber: '6110', debitAmount: -amount, creditAmount: 0 }]
}

export function entry(b: Books, amount: number, extra: Partial<Parameters<typeof insertPostedJournalEntry>[0]> = {}) {
  return insertPostedJournalEntry({
    userId: b.userId,
    companyId: b.companyId,
    fiscalPeriodId: b.period,
    entryDate: DATE,
    lines: bankLines(amount),
    ...extra,
  })
}

export async function correctionOf(
  b: Books,
  original: string,
  amount: number,
  account = '1930',
  lines = bankLines(amount, account),
): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, correction_of_id)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Rättelse', 'correction', 'draft', $6)`,
      [id, b.userId, b.companyId, b.period, DATE, original],
    )
    for (const [index, line] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
         VALUES ($1, $2, $3, $4, 'SEK', $5)`,
        [id, line.accountNumber, line.debitAmount, line.creditAmount, index],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export const reverse = (entryId: string) => getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [entryId])

export async function link(b: Books, txId: string, entryId: string, amount: number, role = 'bank_line') {
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), b.userId, b.companyId, txId, entryId, amount, role],
  )
}

export async function setPointer(txId: string, entryId: string) {
  await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2, is_business = true WHERE id = $1`, [txId, entryId])
}

/** A payment row on the bank row: of a posted verifikat, or of one that was deleted (the FK nulled it). */
export async function payment(b: Books, txId: string, entryId: string | null, amount: number) {
  const customer = randomUUID()
  const invoice = randomUUID()
  await getPool().query(`ALTER TABLE public.invoice_payments DISABLE TRIGGER USER`)
  await getPool().query(`ALTER TABLE public.invoices DISABLE TRIGGER USER`)
  try {
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country) VALUES ($1,$2,$3,'K','swedish_business','SE')`,
      [customer, b.userId, b.companyId],
    )
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-03-01','2026-03-31','paid','SEK',$6,0,$6,$6,0)`,
      [invoice, b.userId, b.companyId, customer, `F-${invoice.slice(0, 6)}`, Math.abs(amount)],
    )
    await getPool().query(
      `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id, transaction_id)
       VALUES ($1,$2,$3,$4,$5,'SEK',$6,$7)`,
      [b.userId, b.companyId, invoice, DATE, Math.abs(amount), entryId, txId],
    )
  } finally {
    await getPool().query(`ALTER TABLE public.invoice_payments ENABLE TRIGGER USER`)
    await getPool().query(`ALTER TABLE public.invoices ENABLE TRIGGER USER`)
  }
}

export type Shape =
  | 'free'
  | 'own_pointer'
  | 'reconciled_pointer'
  | 'stale_pointer'
  | 'corrected'
  | 'corrected_twice'
  | 'correction_reversed'
  | 'correction_left_the_bank'
  | 'link_posted'
  | 'link_reversed'
  | 'link_corrected'
  | 'other_link_only'
  | 'payment_posted'
  | 'payment_reversed'
  | 'payment_corrected'
  | 'payment_verifikat_gone'
  | 'ignored'
  | 'private'

async function bankChart(b: Books) {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     VALUES ($1, $2, '1931', 'Bank', 1, 'asset', 'debit') ON CONFLICT DO NOTHING`,
    [b.userId, b.companyId],
  )
}

export async function row(b: Books, shape: Shape, amount: number): Promise<string> {
  const tx = await insertTransaction({
    companyId: b.companyId,
    userId: b.userId,
    date: DATE,
    amount,
    cashAccountId: b.cash,
    isIgnored: shape === 'ignored',
    description: 'Inbetalning',
  })
  if (shape === 'private') await getPool().query(`UPDATE public.transactions SET is_business = false WHERE id = $1`, [tx])
  if (shape === 'own_pointer') {
    const own = await insertPostedBankJournalEntry({
      userId: b.userId, companyId: b.companyId, fiscalPeriodId: b.period, entryDate: DATE, transactionId: tx, lines: bankLines(amount),
    })
    await setPointer(tx, own)
  }
  if (shape === 'reconciled_pointer') {
    await setPointer(tx, await entry(b, amount))
    await getPool().query(`UPDATE public.transactions SET reconciliation_method = 'manual' WHERE id = $1`, [tx])
  }
  if (['stale_pointer', 'corrected', 'corrected_twice', 'correction_reversed'].includes(shape)) {
    const original = await entry(b, amount)
    await setPointer(tx, original)
    if (shape !== 'stale_pointer') {
      await bankChart(b)
      // The prod shape: the correction took the bank leg to another bank account.
      const first = await correctionOf(b, original, amount, '1931')
      await reverse(original)
      if (shape === 'corrected_twice' || shape === 'correction_reversed') await reverse(first)
      if (shape === 'corrected_twice') await correctionOf(b, first, amount, '1931')
    } else {
      await reverse(original)
    }
  }
  if (shape === 'correction_left_the_bank') {
    const original = await entry(b, amount)
    await setPointer(tx, original)
    // crm#1433: a purchase rebooked as a supplier invoice takes the money off the bank.
    await correctionOf(b, original, amount, '1930', [
      { accountNumber: '6110', debitAmount: Math.abs(amount), creditAmount: 0 },
      { accountNumber: '2999', debitAmount: 0, creditAmount: Math.abs(amount) },
    ])
    await reverse(original)
  }
  if (shape === 'link_posted') await link(b, tx, await entry(b, amount), amount)
  if (shape === 'link_reversed') {
    const e = await entry(b, amount)
    await link(b, tx, e, amount)
    await reverse(e)
  }
  if (shape === 'link_corrected') {
    // A failed relink: correctEntry logs it and the link stays behind.
    const e = await entry(b, amount)
    await link(b, tx, e, amount)
    await correctionOf(b, e, amount)
    await reverse(e)
  }
  if (shape === 'other_link_only') await link(b, tx, await entry(b, amount > 0 ? 10 : -10), amount > 0 ? 10 : -10, 'other')
  if (shape === 'payment_posted') await payment(b, tx, await entry(b, amount), amount)
  if (shape === 'payment_reversed' || shape === 'payment_corrected') {
    const e = await entry(b, amount)
    await payment(b, tx, e, amount)
    if (shape === 'payment_corrected') await correctionOf(b, e, amount)
    await reverse(e)
  }
  if (shape === 'payment_verifikat_gone') await payment(b, tx, null, amount)
  return tx
}

export interface Expected {
  /** public.is_transaction_booked, the computed column and the anchor view. */
  booked: boolean
  /** The rows the work lists show: open work. */
  open: boolean
  /** decideBankRowRebooking without replace; undefined: the gate does not read this shape (no writer makes it). */
  gate?: string
}

export const SHAPES: Record<Shape, Expected> = {
  free: { booked: false, open: true, gate: 'open' },
  own_pointer: { booked: true, open: false, gate: 'refuse:pointer' },
  reconciled_pointer: { booked: true, open: false, gate: 'refuse:reconciliation' },
  stale_pointer: { booked: false, open: true, gate: 'open' },
  corrected: { booked: true, open: false, gate: 'refuse:link' },
  corrected_twice: { booked: true, open: false, gate: 'refuse:link' },
  correction_reversed: { booked: false, open: true, gate: 'open' },
  correction_left_the_bank: { booked: false, open: true, gate: 'open' },
  link_posted: { booked: true, open: false, gate: 'refuse:link' },
  link_reversed: { booked: false, open: true, gate: 'open' },
  link_corrected: { booked: true, open: false, gate: 'refuse:link' },
  other_link_only: { booked: false, open: true, gate: 'open' },
  payment_posted: { booked: true, open: false },
  payment_reversed: { booked: false, open: true },
  payment_corrected: { booked: true, open: false },
  payment_verifikat_gone: { booked: false, open: true, gate: 'open' },
  ignored: { booked: false, open: false, gate: 'refuse:ignored' },
  private: { booked: false, open: false, gate: 'open' },
}

export const AMOUNT = 1250
